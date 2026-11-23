# Auction

A shared player auction website. Run it with Node.js:

```powershell
npm start
```

Then open `http://localhost:3000`. The board starts empty. The admin chooses one photo and types that player's name, then adds more players to a private lineup. Photo filenames are never used as player names. Players remain hidden from bidders until the admin presses **Start bidding**; then the server shuffles the lineup. Admin can enable random group mode and choose a group size (1–40). When on, that many randomly chosen players are displayed together, with remaining players waiting for the next group. When off, the whole lineup is displayed. After a group is sold, the auction waits for the admin to press **Start next group**; queued players and photos remain saved. Each bid button raises the bid by exactly ₹1; a bid is blocked if it would exceed the bidder's balance. The current leader cannot bid again until someone else takes the lead. When auto-sale is on, a five-second countdown begins after each bid. A new bid resets it; when it reaches zero, the server automatically sells the player to the current leader and charges their budget. Admin can turn public bidding and auto-sale on or off separately and review the private sales register. The admin can sign in with the demo passcode `1234` and set each bidder's budget. Bids are refreshed for everyone every half-second and saved in `auction-data.json` on the server.

To use it on your local network, open port 3000 in your firewall and visit `http://YOUR-COMPUTER-IP:3000` from other devices on the same network. To let people bid over the internet, host this Node app on a server with persistent disk storage.

## Hosting online

For an always-on deployment, use a paid Render Web Service with a persistent disk. Free Render web services sleep after 15 minutes without traffic and do not support persistent disks.

1. Put the project files in a GitHub repository. Do not upload `auction-data.json`; it contains the live auction data and is ignored by Git.
2. In Render, create a **Web Service** and connect that repository. Use `npm install` as the build command and `npm start` as the start command. Choose a paid plan for always-on service.
3. Add a persistent disk mounted at `/opt/render/project/src/storage`.
4. Add environment variables: `AUCTION_DATA_FILE=/opt/render/project/src/storage/auction-data.json` and `AUCTION_ADMIN_PASSWORD` set to a private passcode.
5. Deploy. Open the `onrender.com` address Render gives you and sign in to Admin with the passcode you set.

The app binds to the host-provided port and `0.0.0.0`. Keep this JSON-backed app on one service instance; use a database before scaling to multiple instances.

Before sharing outside your network, set `AUCTION_ADMIN_PASSWORD` to a private passcode. Participants currently join by choosing a unique name in this browser; a public production auction should use proper user accounts, rate limiting, and a hosted database to prevent people creating extra bidder profiles.
