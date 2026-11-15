// Start an ngrok tunnel on the fixed address in PUBLIC_BASE_URL, forwarding to this server's port.
//   npm run tunnel
// ngrok gives every free account ONE fixed "dev domain" (name like something-words.ngrok-free.dev), so the address
// survives restarts and the Twilio number never needs re-pointing. Set it once in .env:
//   PUBLIC_BASE_URL=https://your-domain.ngrok-free.dev
// One-time setup: install ngrok, then run `ngrok config add-authtoken <your token>` yourself (the token stays in ngrok's own config).
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
if (!config.publicBaseUrl.startsWith("https://") || /localhost|127\.0\.0\.1|trycloudflare\.com/.test(config.publicBaseUrl)) {
  console.error(
    `PUBLIC_BASE_URL is "${config.publicBaseUrl}". Set it in .env to your fixed ngrok dev domain, for example https://your-domain.ngrok-free.dev (ngrok dashboard > Domains).`,
  );
  process.exit(1);
}

console.log(`Forwarding ${config.publicBaseUrl} -> http://localhost:${config.port}  (Ctrl+C to stop)`);
const child = spawn("ngrok", ["http", String(config.port), "--url", config.publicBaseUrl], { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error(`Could not start ngrok: ${e.message}. Is it installed (winget install Ngrok.Ngrok) and is this a fresh terminal?`);
  process.exit(1);
});
