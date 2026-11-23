const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.AUCTION_HOST || process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.AUCTION_ADMIN_PASSWORD || '1234';
const AUTO_SALE_DELAY_MS = 5000;
const DATA_FILE = process.env.AUCTION_DATA_FILE || path.join(ROOT, 'auction-data.json');
const sessions = new Set();
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const participants = Array.isArray(data.participants) ? data.participants : [];
    return {
      players: Array.isArray(data.players) ? data.players.map((player) => ({ ...player, bids: Array.isArray(player.bids) ? player.bids : [] })) : [],
      draftPlayers: Array.isArray(data.draftPlayers) ? data.draftPlayers : [],
      participants,
      budget: Number.isFinite(Number(data.budget)) && Number(data.budget) >= 1 ? Number(data.budget) : 1000,
      settings: {
        biddingEnabled: data.settings?.biddingEnabled !== false,
        autoSaleEnabled: data.settings?.autoSaleEnabled !== false,
        randomGroupEnabled: data.settings?.randomGroupEnabled !== false && data.settings?.showPlayersTogether !== false,
        playersPerBatch: Math.min(40, Math.max(1, Math.floor(Number(data.settings?.playersPerBatch) || 1)))
      },
      order: Array.isArray(data.order) ? data.order : shuffleIds(Array.isArray(data.players) ? data.players.filter((player) => !player.sold).map((player) => player.id) : []),
      currentPlayerId: typeof data.currentPlayerId === 'string' ? data.currentPlayerId : '',
      batchIds: Array.isArray(data.batchIds) ? data.batchIds : [],
      awaitingNextGroup: data.awaitingNextGroup === true
    };
  } catch { return { players: [] }; }
}
let data = loadData();
data.participants ||= [];
data.draftPlayers ||= [];
data.budget ||= 1000;
data.settings ||= { biddingEnabled: true, autoSaleEnabled: true, randomGroupEnabled: true, playersPerBatch: 1 };
data.settings.randomGroupEnabled = data.settings.randomGroupEnabled !== false && data.settings.showPlayersTogether !== false;
data.settings.playersPerBatch = Math.min(40, Math.max(1, Math.floor(Number(data.settings.playersPerBatch) || 1)));
data.order ||= shuffleIds(data.players.filter((player) => !player.sold).map((player) => player.id));
data.currentPlayerId ||= data.order[0] || '';
data.batchIds ||= [];
data.awaitingNextGroup = data.awaitingNextGroup === true;
data.revision = 1;
function saveData() {
  data.revision++;
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}
function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) { reject(new Error('Request is too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid request data.')); }
    });
    req.on('error', reject);
  });
}
function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token && sessions.has(token)) return true;
  send(res, 401, { error: 'Admin sign-in required.' });
  return false;
}
function serveFile(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
function leadingBid(player) {
  return (player.bids || []).reduce((best, bid) => Number(bid.amount) > Number(best?.amount || 0) ? bid : best, null);
}
function shuffleIds(ids) {
  for (let i = ids.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}
function findPlayer(id) { return data.players.find((player) => player.id === id); }
function currentPlayer() {
  data.order = data.order.filter((id, index, order) => findPlayer(id) && !findPlayer(id).sold && order.indexOf(id) === index);
  data.batchIds = data.batchIds.filter((id, index, ids) => findPlayer(id) && !findPlayer(id).sold && ids.indexOf(id) === index);
  if (!data.batchIds.length && !data.awaitingNextGroup) data.batchIds = data.order.slice(0, data.settings.playersPerBatch || 1);
  data.currentPlayerId = data.batchIds[0] || '';
  return findPlayer(data.currentPlayerId) || null;
}
function activePlayers() {
  const active = currentPlayer();
  if (!active) return [];
  if (!data.settings.randomGroupEnabled) return data.order.map(findPlayer).filter((player) => player && !player.sold);
  return data.batchIds.map(findPlayer).filter((player) => player && !player.sold);
}
function queueRandomly(players) {
  const active = currentPlayer();
  const waiting = data.order.filter((id) => findPlayer(id) && !findPlayer(id).sold && id !== active?.id);
  for (const player of players) waiting.splice(crypto.randomInt(waiting.length + 1), 0, player.id);
  data.order = active ? [active.id, ...waiting] : waiting;
  data.batchIds = [];
  if (!active) data.currentPlayerId = data.order[0] || '';
}
function advancePlayer(id) {
  data.order = data.order.filter((queuedId) => queuedId !== id && findPlayer(queuedId) && !findPlayer(queuedId).sold);
  data.batchIds = data.batchIds.filter((queuedId) => queuedId !== id);
  if (!data.batchIds.length && data.order.length) data.awaitingNextGroup = true;
  currentPlayer();
}
function participantBalance(participantId) {
  const participant = data.participants.find((item) => item.id === participantId);
  if (!participant) return null;
  const held = data.players.reduce((sum, player) => {
    if (player.sold) return sum;
    const top = leadingBid(player);
    return sum + (top?.participantId === participantId ? Number(top.amount) : 0);
  }, 0);
  return {
    id: participant.id,
    name: participant.name,
    purse: participant.purse,
    spent: participant.spent || 0,
    held,
    balance: Math.max(0, participant.purse - (participant.spent || 0) - held)
  };
}
function heldBy(participantId, exceptPlayerId = '') {
  return data.players.reduce((sum, player) => {
    if (player.id === exceptPlayerId || player.sold) return sum;
    const top = leadingBid(player);
    return sum + (top?.participantId === participantId ? Number(top.amount) : 0);
  }, 0);
}
function settleAtHighestBid(player, automatic = false) {
  const top = leadingBid(player);
  if (!top?.participantId) return false;
  const winner = data.participants.find((item) => item.id === top.participantId);
  if (!winner || winner.purse - (winner.spent || 0) - heldBy(winner.id, player.id) < Number(top.amount)) return false;
  player.sold = true;
  player.buyer = winner.name;
  player.price = Number(top.amount);
  player.chargedParticipantId = winner.id;
  player.autoSold = automatic;
  player.soldAt = Date.now();
  winner.spent = (winner.spent || 0) + player.price;
  if (data.currentPlayerId === player.id) advancePlayer(player.id);
  return true;
}
function settleInactiveBids() {
  if (!data.settings.autoSaleEnabled) return;
  const now = Date.now();
  let changed = false;
  const activeIds = new Set(activePlayers().map((player) => player.id));
  for (const player of data.players) {
    if (activeIds.has(player.id) && !player.sold && Number(player.lastBidAt) > 0 && now - Number(player.lastBidAt) >= AUTO_SALE_DELAY_MS) {
      changed = settleAtHighestBid(player, true) || changed;
    }
  }
  if (changed) saveData();
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/state') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const participantId = params.get('participantId');
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAdmin = Boolean(token && sessions.has(token));
      const version = `${data.revision}:${isAdmin ? 'admin' : participantId || 'public'}`;
      if (params.get('version') === version) {
        res.writeHead(304, { 'cache-control': 'no-store' }); res.end(); return;
      }
      const active = activePlayers();
      return send(res, 200, {
        players: active, currentPlayerId: active[0]?.id || '',
        draftPlayers: isAdmin ? data.draftPlayers : [],
        hasPlayers: data.players.length > 0, complete: data.players.length > 0 && data.players.every((player) => player.sold),
        awaitingNextGroup: data.awaitingNextGroup,
        hasQueuedPlayers: isAdmin && data.order.some((id) => findPlayer(id) && !findPlayer(id).sold),
        sales: isAdmin ? data.players.filter((player) => player.sold).map(({ id, name, buyer, price }) => ({ id, name, buyer, price })) : [],
        budget: data.budget, settings: data.settings, participant: participantId ? participantBalance(participantId) : null,
        serverNow: Date.now(), version
      });
    }
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const body = await readBody(req);
      if (typeof body.password !== 'string' || body.password !== ADMIN_PASSWORD) return send(res, 401, { error: 'That passcode does not match.' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.add(token);
      return send(res, 200, { token });
    }
    if (req.method === 'GET' && pathname === '/api/admin/session') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, { valid: true });
    }
    if (req.method === 'POST' && pathname === '/api/participants') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!name) return send(res, 400, { error: 'Enter your name to join the auction.' });
      if (data.participants.some((item) => item.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That name is already in use. Try a different name.' });
      const participant = { id: crypto.randomUUID(), name, purse: data.budget, spent: 0 };
      data.participants.push(participant); saveData();
      return send(res, 201, { participant, balance: participantBalance(participant.id) });
    }
    if (req.method === 'POST' && pathname === '/api/bids') {
      const body = await readBody(req);
      if (!data.settings.biddingEnabled) return send(res, 409, { error: 'Bidding is paused by the admin.' });
      const player = data.players.find((item) => item.id === String(body.playerId || ''));
      if (!player) return send(res, 404, { error: 'Player not found.' });
      if (!activePlayers().some((active) => active.id === player.id)) return send(res, 409, { error: 'This player is not up for bidding yet.' });
      if (player.sold) return send(res, 409, { error: 'Bidding has ended for this player.' });
      const participant = data.participants.find((item) => item.id === String(body.participantId || ''));
      if (!participant) return send(res, 401, { error: 'Enter your name to join before bidding.' });
      const top = leadingBid(player);
      if (top?.participantId === participant.id) return send(res, 409, { error: 'You are already leading. Wait for someone else to bid.' });
      const amount = Number(top?.amount || 0) + 1;
      const wallet = participantBalance(participant.id);
      const availableForThisBid = wallet.balance + (top?.participantId === participant.id ? Number(top.amount) : 0);
      if (amount > availableForThisBid) return send(res, 409, { error: `You need ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount)} available to bid.` });
      player.bids = player.bids || [];
      player.bids.push({ participantId: participant.id, name: participant.name, amount, at: new Date().toISOString() });
      player.lastBidAt = Date.now();
      player.autoSold = false;
      saveData();
      return send(res, 201, { ok: true, player, participant: participantBalance(participant.id) });
    }
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (pathname === '/api/admin/budget') {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 100000000) return send(res, 400, { error: 'Set a purse between ₹1 and ₹10,00,00,000.' });
        for (const item of data.participants) {
          const committed = (item.spent || 0) + heldBy(item.id);
          if (amount < committed) return send(res, 409, { error: `${item.name} has already committed ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(committed)}. Set a larger budget.` });
        }
        data.budget = amount;
        for (const participant of data.participants) participant.purse = amount;
        saveData();
        return send(res, 200, { budget: data.budget });
      }
      if (pathname === '/api/admin/settings') {
        const wasAutoSaleEnabled = data.settings.autoSaleEnabled;
        const previousBatchSize = data.settings.playersPerBatch;
        const batchSize = Number(body.playersPerBatch);
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 40) return send(res, 400, { error: 'Choose between 1 and 40 players to show at once.' });
        data.settings.biddingEnabled = Boolean(body.biddingEnabled);
        data.settings.autoSaleEnabled = Boolean(body.autoSaleEnabled);
        if (typeof body.randomGroupEnabled === 'boolean') data.settings.randomGroupEnabled = body.randomGroupEnabled;
        data.settings.playersPerBatch = batchSize;
        if (batchSize !== previousBatchSize && !data.awaitingNextGroup) {
          currentPlayer();
          data.batchIds = data.order.slice(0, batchSize);
          data.currentPlayerId = data.batchIds[0] || '';
        }
        if (!wasAutoSaleEnabled && data.settings.autoSaleEnabled) {
          const now = Date.now();
          for (const active of activePlayers()) if (leadingBid(active)) active.lastBidAt = now;
        }
        saveData();
        return send(res, 200, { settings: data.settings });
      }
      if (pathname === '/api/admin/start') {
        const canStartNextGroup = data.awaitingNextGroup && data.order.some((id) => findPlayer(id) && !findPlayer(id).sold);
        if (!data.draftPlayers.length && !canStartNextGroup) return send(res, 400, { error: 'Add players or wait for the current group to finish.' });
        if (data.draftPlayers.length) {
          const newPlayers = data.draftPlayers.map((player) => ({ ...player, bids: [] }));
          data.players.push(...newPlayers);
          queueRandomly(newPlayers);
          data.draftPlayers = [];
        }
        data.awaitingNextGroup = false;
        currentPlayer();
        data.settings.biddingEnabled = true;
        saveData();
        return send(res, 200, { ok: true, currentPlayerId: data.currentPlayerId });
      }
      if (pathname === '/api/admin/clear-lineup') {
        data.players = [];
        data.draftPlayers = [];
        data.order = [];
        data.batchIds = [];
        data.currentPlayerId = '';
        data.awaitingNextGroup = false;
        for (const participant of data.participants) participant.spent = 0;
        saveData();
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/players') {
        const incoming = Array.isArray(body.players) ? body.players : [body];
        if (!incoming.length || incoming.length > 100) return send(res, 400, { error: 'Upload up to 100 queued players.' });
        const added = incoming.map((item) => ({
          id: crypto.randomUUID(), name: String(item.name || '').trim().slice(0, 50),
          photo: typeof item.photo === 'string' && item.photo.length < 7 * 1024 * 1024 ? item.photo : '',
          sold: false, buyer: '', price: null, bids: []
        }));
        if (added.some((player) => !player.name)) return send(res, 400, { error: 'Enter a name for every player.' });
        data.draftPlayers.push(...added.map(({ bids, ...player }) => player)); saveData();
        return send(res, 201, { players: added, draftPlayers: data.draftPlayers });
      }
      const draftRemoval = pathname.match(/^\/api\/admin\/draft-players\/([^/]+)\/remove$/);
      if (draftRemoval) {
        data.draftPlayers = data.draftPlayers.filter((player) => player.id !== draftRemoval[1]);
        saveData();
        return send(res, 200, { ok: true });
      }
      const match = pathname.match(/^\/api\/players\/([^/]+)\/(bid|sell|unsell|remove)$/);
      if (!match) return send(res, 404, { error: 'Unknown action.' });
      const [, id, action] = match;
      const index = data.players.findIndex((player) => player.id === id);
      if (index < 0) return send(res, 404, { error: 'Player not found.' });
      const player = data.players[index];
      if (action === 'bid') return send(res, 405, { error: 'Bids are public. Use the public bid endpoint.' });
      if (action === 'remove') {
        if (player.chargedParticipantId) {
          const charged = data.participants.find((item) => item.id === player.chargedParticipantId);
          if (charged) charged.spent = Math.max(0, (charged.spent || 0) - Number(player.price || 0));
        }
        const wasCurrent = data.currentPlayerId === player.id;
        data.players.splice(index, 1);
        if (wasCurrent) advancePlayer(player.id);
        else data.order = data.order.filter((queuedId) => queuedId !== player.id);
      }
      if (action === 'unsell') {
        if (player.chargedParticipantId) {
          const charged = data.participants.find((item) => item.id === player.chargedParticipantId);
          if (charged) charged.spent = Math.max(0, (charged.spent || 0) - Number(player.price || 0));
        }
        player.sold = false; player.buyer = ''; player.price = null; player.chargedParticipantId = '';
        player.autoSold = false; player.soldAt = null;
        player.lastBidAt = leadingBid(player)?.participantId ? Date.now() : 0;
        data.order = data.order.filter((queuedId) => queuedId !== player.id);
        data.order.splice(crypto.randomInt(data.order.length + 1), 0, player.id);
        if (!currentPlayer()) data.currentPlayerId = data.order[0] || '';
      }
      if (action === 'sell') {
        const top = leadingBid(player);
        if (top?.participantId) {
          if (!settleAtHighestBid(player)) return send(res, 409, { error: 'The leading bidder no longer has enough balance.' });
        } else {
          const buyer = String(body.buyer || '').trim().slice(0, 50);
          const price = Number(body.price);
          if (!buyer || !Number.isFinite(price) || price < 0) return send(res, 400, { error: 'Enter a buyer and valid winning bid.' });
          player.sold = true; player.buyer = buyer; player.price = price; player.chargedParticipantId = '';
          if (data.currentPlayerId === player.id) advancePlayer(player.id);
        }
      }
      saveData();
      return send(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    if (req.method === 'GET') return serveFile(req, res);
    res.writeHead(405); res.end('Method not allowed');
  } catch (error) {
    if (!res.headersSent) send(res, 400, { error: error.message || 'Request failed.' });
  }
});

settleInactiveBids();
setInterval(settleInactiveBids, 200);
server.listen(PORT, HOST, () => {
  console.log(`Auction is running at http://localhost:${PORT}`);
  if (HOST === '127.0.0.1') console.log('Local access only. Set AUCTION_HOST=0.0.0.0 to allow devices on your network.');
  console.log(`Admin passcode: ${ADMIN_PASSWORD === '1234' ? '1234 (demo; set AUCTION_ADMIN_PASSWORD before sharing)' : 'configured from AUCTION_ADMIN_PASSWORD'}`);
});
