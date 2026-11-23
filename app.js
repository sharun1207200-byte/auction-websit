(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'auction-admin-token';
  const PARTICIPANT_KEY = 'auction-participant-id';
  const AUTO_SALE_DELAY_MS = 5000;
  let players = [];
  let draftPlayers = [];
  let sales = [];
  let auctionComplete = false;
  let hasPlayers = false;
  let awaitingNextGroup = false;
  let hasQueuedPlayers = false;
  let budget = 1000;
  let settings = { biddingEnabled: true, autoSaleEnabled: true, randomGroupEnabled: true, playersPerBatch: 1 };
  let stateVersion = 0;
  let participantId = localStorage.getItem(PARTICIPANT_KEY) || '';
  let participant = null;
  let serverClockOffset = 0;
  let adminToken = sessionStorage.getItem(TOKEN_KEY) || '';
  let isAdmin = Boolean(adminToken);
  let photoData = '';
  let toastTimer;

  async function api(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (adminToken) headers.authorization = `Bearer ${adminToken}`;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 304) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && adminToken && path !== '/api/bids') {
        adminToken = ''; sessionStorage.removeItem(TOKEN_KEY); isAdmin = false;
        $('adminPanel').hidden = true; $('adminButtonText').textContent = 'Admin sign in';
      }
      throw new Error(body.error || 'Could not connect to the auction server.');
    }
    return body;
  }
  function money(value) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function initials(name) { return escapeHtml(name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()); }
  function highestBid(player) {
    return (player.bids || []).reduce((best, bid) => Number(bid.amount) > Number(best?.amount || 0) ? bid : best, null);
  }
  function render() {
    $('playerGrid').innerHTML = players.map((player) => {
      const topBid = highestBid(player);
      const nextAmount = Number(topBid?.amount || 0) + 1;
      const deadline = Number(player.lastBidAt || 0) + AUTO_SALE_DELAY_MS;
      const secondsLeft = Math.max(0, Math.ceil((deadline - (Date.now() + serverClockOffset)) / 1000));
      const isLeadingBidder = topBid?.participantId === participantId;
      const canBid = Boolean(participant) && settings.biddingEnabled && !player.sold && !isLeadingBidder && participant.balance >= nextAmount;
      const bidSummary = topBid
        ? `<div class="bid-summary"><span>HIGHEST BID</span><strong>${money(topBid.amount)}</strong><small>by ${escapeHtml(topBid.name)}</small></div>`
        : `<div class="bid-summary no-bids"><span>STARTING BID</span><strong>${money(1)}</strong><small>No bids yet</small></div>`;
      const countdown = topBid && !player.sold
        ? settings.autoSaleEnabled && player.lastBidAt
          ? `<div class="auction-countdown" data-deadline="${deadline}" data-leading="${isLeadingBidder}">${isLeadingBidder ? `You’re leading · auto-sale in ${secondsLeft}s` : `Auto-sells in ${secondsLeft}s if no new bid`}</div>`
          : !settings.autoSaleEnabled ? '<div class="auction-countdown timer-off">Auto-sale is off</div>' : ''
        : '';
      const bidButton = player.sold
        ? `<div class="auction-ended">${player.autoSold ? 'Auto-sold after 5 seconds' : 'Bidding ended'}</div>`
        : `<button class="player-action bid-action" data-action="bid" data-id="${escapeHtml(player.id)}" ${canBid ? '' : 'disabled'}>${!settings.biddingEnabled ? 'Bidding paused' : isLeadingBidder ? 'You’re leading · wait for a bid' : canBid ? `Bid to ${money(nextAmount)} ↗` : participant ? 'Not enough balance' : 'Join to bid'}</button>`;
      return `<article class="player-card">
        <div class="player-photo-wrap">${player.photo ? `<img class="player-photo" src="${player.photo}" alt="${escapeHtml(player.name)}" loading="lazy">` : `<div class="player-placeholder" aria-label="No photo uploaded">${initials(player.name)}</div>`}<span class="player-status"><span class="status-dot"></span>${player.sold ? 'Sold' : 'Available'}</span></div>
        <div class="player-info"><h3>${escapeHtml(player.name)}</h3>${bidSummary}${countdown}${bidButton}
          ${isAdmin ? `<div class="player-actions">${player.sold ? `<button class="player-action" data-action="unsell" data-id="${escapeHtml(player.id)}">Undo sale</button>` : `<button class="player-action sell" data-action="sell" data-id="${escapeHtml(player.id)}">Mark as sold ↗</button>`}<button class="player-action" data-action="remove" data-id="${escapeHtml(player.id)}">Remove</button></div>` : ''}
        </div>
      </article>`;
    }).join('');
    $('emptyState').hidden = players.length > 0;
    $('salesTableBody').innerHTML = sales.map((player) => `<tr><td>${escapeHtml(player.name)}</td><td>${escapeHtml(player.buyer)}</td><td>${money(player.price)}</td></tr>`).join('');
    $('salesEmpty').hidden = sales.length > 0;
    $('salesTotal').textContent = money(sales.reduce((sum, player) => sum + (Number(player.price) || 0), 0));
    $('pendingPlayerCount').textContent = String(draftPlayers.length);
    $('pendingPlayerList').innerHTML = draftPlayers.length
      ? draftPlayers.map((player) => `<div class="pending-player-row"><img src="${player.photo}" alt=""><span>${escapeHtml(player.name)}</span><button class="player-action" type="button" data-draft-action="remove" data-id="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">×</button></div>`).join('')
      : '<p class="pending-empty">Add players above, then start the auction.</p>';
    $('startBiddingButton').disabled = draftPlayers.length === 0 && !(awaitingNextGroup && hasQueuedPlayers);
    $('startBiddingButton').innerHTML = awaitingNextGroup && draftPlayers.length === 0
      ? 'Start next group <span>↗</span>'
      : 'Start bidding <span>↗</span>';
    if ($('clearLineupButton')) $('clearLineupButton').disabled = draftPlayers.length === 0 && !hasPlayers;
    $('emptyState').querySelector('h3').textContent = auctionComplete ? 'Auction complete' : awaitingNextGroup ? 'Next group is waiting' : 'No players yet';
    $('emptyState').querySelector('p').textContent = auctionComplete ? 'Every player has been sold.' : awaitingNextGroup ? 'The admin will start the next random group soon.' : 'Players added by the admin will appear here.';
    $('participantBadge').hidden = !participant;
    if ($('biddingToggle')) $('biddingToggle').checked = settings.biddingEnabled;
    if ($('autoSaleToggle')) $('autoSaleToggle').checked = settings.autoSaleEnabled;
    if ($('randomGroupToggle')) $('randomGroupToggle').checked = settings.randomGroupEnabled !== false;
    if ($('playersPerBatchInput') && $('playersPerBatchInput').dataset.loaded !== 'true') {
      $('playersPerBatchInput').value = settings.playersPerBatch || 1;
      $('playersPerBatchInput').dataset.loaded = 'true';
    }
    if (participant) {
      $('participantName').textContent = participant.name;
      $('participantBalance').textContent = `Available ${money(participant.balance)}`;
    }
    updateCountdowns();
  }
  function updateCountdowns() {
    const now = Date.now() + serverClockOffset;
    document.querySelectorAll('[data-deadline]').forEach((item) => {
      const seconds = Math.max(0, Math.ceil((Number(item.dataset.deadline) - now) / 1000));
      item.textContent = item.dataset.leading === 'true'
        ? `You’re leading · auto-sale in ${seconds}s`
        : `Auto-sells in ${seconds}s if no new bid`;
    });
  }
  function showToast(message) {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }
  function askForName() {
    if (participantId || $('nameDialog').open) return;
    $('nameError').hidden = true; $('nameDialog').showModal(); $('visitorNameInput').focus();
  }
  async function refreshState() {
    try {
      const params = new URLSearchParams();
      if (participantId) params.set('participantId', participantId);
      if (stateVersion) params.set('version', stateVersion);
      const state = await api(`/api/state${params.size ? `?${params}` : ''}`);
      if (!state) return;
      stateVersion = state.version || stateVersion;
      serverClockOffset = Number(state.serverNow || Date.now()) - Date.now();
      players = state.players || []; draftPlayers = state.draftPlayers || []; sales = state.sales || []; auctionComplete = Boolean(state.complete); hasPlayers = Boolean(state.hasPlayers);
      awaitingNextGroup = Boolean(state.awaitingNextGroup); hasQueuedPlayers = Boolean(state.hasQueuedPlayers);
      budget = state.budget || 1000; settings = state.settings || settings; participant = state.participant || null;
      if (participantId && !participant) {
        participantId = ''; localStorage.removeItem(PARTICIPANT_KEY); participant = null;
        askForName();
      }
      if ($('budgetInput') && $('budgetInput').dataset.loaded !== 'true') {
        $('budgetInput').value = budget; $('budgetInput').dataset.loaded = 'true';
      }
      render();
    } catch {
      if (!players.length) $('emptyState').querySelector('p').textContent = 'Start the auction server to load players and place bids.';
    }
  }
  async function adminAction(path, body = {}) {
    await api(path, { method: 'POST', body: JSON.stringify(body) });
    await refreshState();
  }
  function setAdmin(value, scroll = true) {
    isAdmin = value; $('adminPanel').hidden = !value;
    $('adminButtonText').textContent = value ? 'Admin signed in' : 'Admin sign in';
    render();
    if (value && scroll) $('adminPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('nameDialog').addEventListener('cancel', (event) => event.preventDefault());
  $('nameForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('nameError').hidden = true;
    try {
      const result = await api('/api/participants', { method: 'POST', body: JSON.stringify({ name: $('visitorNameInput').value.trim() }) });
      participantId = result.participant.id;
      localStorage.setItem(PARTICIPANT_KEY, participantId);
      participant = result.balance; $('nameDialog').close();
      await refreshState(); showToast(`Welcome, ${participant.name}. Your budget is ${money(participant.purse)}.`);
    } catch (error) { $('nameError').textContent = error.message; $('nameError').hidden = false; }
  });

  $('adminButton').addEventListener('click', () => {
    if (isAdmin) { $('adminPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    $('loginError').hidden = true; $('passcodeInput').value = ''; $('adminDialog').showModal();
  });
  $('closeDialog').addEventListener('click', () => $('adminDialog').close());
  $('adminDialog').addEventListener('click', (event) => { if (event.target === $('adminDialog')) $('adminDialog').close(); });
  $('adminLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('passcodeInput').value }) });
      adminToken = result.token; sessionStorage.setItem(TOKEN_KEY, adminToken);
      $('adminDialog').close(); setAdmin(true); showToast('Admin mode unlocked.');
    } catch { $('loginError').hidden = false; }
  });
  $('adminSignOut').addEventListener('click', () => {
    adminToken = ''; sessionStorage.removeItem(TOKEN_KEY); setAdmin(false); showToast('Signed out.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }
  $('photoInput').addEventListener('change', async () => {
    const file = $('photoInput').files[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) { showToast(`${file.name} must be an image under 5 MB.`); $('photoInput').value = ''; return; }
    try {
      photoData = await fileToDataUrl(file);
      $('photoPreview').src = photoData;
      $('photoPreview').hidden = false;
    } catch (error) { showToast(error.message); }
  });
  $('addPlayerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('playerNameInput').value.trim();
    if (!name) { showToast('Enter the player name.'); return; }
    if (!photoData) { showToast('Choose this player’s photo.'); return; }
    try {
      await api('/api/players', { method: 'POST', body: JSON.stringify({ name, photo: photoData }) });
      await refreshState();
      $('playerNameInput').value = ''; $('photoInput').value = ''; photoData = ''; $('photoPreview').hidden = true;
      showToast(`${name} added to the lineup. Add another player or start bidding.`);
    } catch (error) { showToast(error.message); }
  });
  $('startBiddingButton').addEventListener('click', async () => {
    const startingNextGroup = awaitingNextGroup && draftPlayers.length === 0;
    try {
      await api('/api/admin/start', { method: 'POST', body: '{}' });
      await refreshState();
      showToast(startingNextGroup ? 'The next random group is ready.' : 'Bidding started. A random group of players is now displayed.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) { showToast(error.message); }
  });
  $('clearLineupButton').addEventListener('click', async () => {
    if (!confirm('Clear all uploaded players, photos, and sale records? This restores bidders’ spent balances.')) return;
    try {
      await api('/api/admin/clear-lineup', { method: 'POST', body: '{}' });
      await refreshState();
      showToast('All players and sale records were cleared.');
    } catch (error) { showToast(error.message); }
  });
  $('pendingPlayerList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-draft-action="remove"]');
    if (!button) return;
    try {
      await api(`/api/admin/draft-players/${encodeURIComponent(button.dataset.id)}/remove`, { method: 'POST', body: '{}' });
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $('budgetForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await adminAction('/api/admin/budget', { amount: Number($('budgetInput').value) });
      showToast(`Bidder budget set to ${money(budget)}.`);
    } catch (error) { showToast(error.message); }
  });
  async function saveAuctionSettings() {
    try {
      const result = await adminAction('/api/admin/settings', {
        biddingEnabled: $('biddingToggle').checked,
        autoSaleEnabled: $('autoSaleToggle').checked,
        randomGroupEnabled: $('randomGroupToggle').checked,
        playersPerBatch: Number($('playersPerBatchInput').value)
      });
      settings = result.settings; render();
      showToast(`Bidding ${settings.biddingEnabled ? 'on' : 'off'} · auto-sale ${settings.autoSaleEnabled ? 'on' : 'off'}.`);
    } catch (error) { showToast(error.message); await refreshState(); }
  }
  $('biddingToggle').addEventListener('change', saveAuctionSettings);
  $('autoSaleToggle').addEventListener('change', saveAuctionSettings);
  $('randomGroupToggle').addEventListener('change', saveAuctionSettings);
  $('playersPerBatchInput').addEventListener('change', saveAuctionSettings);
  $('playerGrid').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const player = players.find((item) => item.id === button.dataset.id); if (!player) return;
    if (button.dataset.action === 'bid') {
      if (!participant) { askForName(); return; }
      try {
        const result = await api('/api/bids', { method: 'POST', body: JSON.stringify({ playerId: player.id, participantId }) });
        const top = highestBid(result.player);
        participant = result.participant; await refreshState();
        showToast(`You bid ${money(top?.amount)} on ${player.name}.`);
      } catch (error) { showToast(error.message); await refreshState(); }
      return;
    }
    if (!isAdmin) return;
    try {
      if (button.dataset.action === 'sell') {
        const topBid = highestBid(player);
        $('salePlayerId').value = player.id; $('saleHeading').textContent = `Sell ${player.name}.`;
        $('buyerInput').value = topBid?.name || ''; $('priceInput').value = topBid?.amount || '';
        $('buyerInput').readOnly = Boolean(topBid); $('priceInput').readOnly = Boolean(topBid);
        $('saleHelp').textContent = topBid ? `${topBid.name} wins at ${money(topBid.amount)}. This amount will be taken from their budget.` : 'No bids yet. Enter the buyer and final price.';
        $('saleDialog').showModal(); $('buyerInput').focus();
      } else if (button.dataset.action === 'unsell') {
        await adminAction(`/api/players/${encodeURIComponent(player.id)}/unsell`); showToast('Sale undone; the winner’s balance is restored.');
      } else if (button.dataset.action === 'remove') {
        await adminAction(`/api/players/${encodeURIComponent(player.id)}/remove`); showToast(`${player.name} removed.`);
      }
    } catch (error) { showToast(error.message); }
  });
  document.querySelectorAll('[data-close-sale]').forEach((button) => button.addEventListener('click', () => $('saleDialog').close()));
  $('saleDialog').addEventListener('click', (event) => { if (event.target === $('saleDialog')) $('saleDialog').close(); });
  $('saleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const player = players.find((item) => item.id === $('salePlayerId').value); if (!player) return;
    const buyer = $('buyerInput').value.trim(); const price = Number($('priceInput').value);
    try {
      await adminAction(`/api/players/${encodeURIComponent(player.id)}/sell`, { buyer, price });
      $('saleDialog').close(); showToast(`${player.name} sold to ${buyer} for ${money(price)}.`);
    } catch (error) { showToast(error.message); }
  });

  if (!participantId) askForName();
  async function initialize() {
    if (adminToken) {
      try { await api('/api/admin/session'); setAdmin(true, false); }
      catch { /* A restarted server has cleared the old admin session. */ }
    }
    await refreshState();
  }
  initialize();
  window.setInterval(refreshState, 500);
  window.setInterval(updateCountdowns, 200);
})();
