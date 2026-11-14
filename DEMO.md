# Running Harborline on real phones

This is the checklist for making a real phone call to your own Twilio number and having the whole system answer.
Everything here uses **your own** phone numbers. Nothing dials a stranger.

## What you need (once)

| You need | Why | Where |
|---|---|---|
| A Twilio account with a **voice-capable US number** | the number people call | Twilio Console > Phone Numbers |
| `TWILIO_ACCOUNT_SID` (starts `AC`) and `TWILIO_AUTH_TOKEN` | the setup and readiness tools talk to your account | Console home page |
| **Phone A**: your own mobile | you call from it | you have it |
| **Phone B**: a second phone | plays the "agent" that a caller is connected to | a friend's phone, a second SIM, or a desk phone |
| A public **https** address for this server | Twilio must be able to reach it | a tunnel (below) or a host |
| (trial accounts) Phone B **verified** | Twilio's trial rules commonly restrict who it will call; `npm run doctor` tells you what it sees | Console > Verified Caller IDs |

Optional, for extra scenes: a Stripe **test-mode** account and a Twilio Pay Connector (card payments), a Twilio texting number (ID-card texts), a Trust Hub business profile (outbound caller-ID registration).

### Your `.env` (names only: never paste values anywhere public)

```
TWILIO_AUTH_TOKEN=...        # required
TWILIO_ACCOUNT_SID=AC...     # needed by doctor / twilio:setup
TWILIO_PHONE_NUMBER=+1...    # your Twilio number
AGENT_PHONE=+1...            # Phone B
HOURS_MODE=always-open       # demo only: ignore business hours
# PUBLIC_BASE_URL is set per session (below), so you do not edit .env each time
```

## Each demo session

1. **Start a tunnel** in terminal 1. The free Cloudflare "quick tunnel" needs no account (first time only: download `cloudflared.exe` into a `tools` folder; see "Getting the tunnel tool" below):
   ```
   npm run tunnel
   ```
   It prints an address like `https://random-words.trycloudflare.com`. That address **changes every time** the tunnel starts, and a restart of the tunnel means repeating steps 2 to 4.
2. **Start the server** in terminal 2, telling it that address (Twilio signs requests using it, so the server must know it):
   ```
   PUBLIC_BASE_URL=https://random-words.trycloudflare.com npm start
   ```
   (Windows PowerShell: `$env:PUBLIC_BASE_URL="https://random-words.trycloudflare.com"; npm start`)
   Read the lines it prints: they say plainly what mode it is in, and any `!!` line is a problem.
3. **Check the public address reaches it**: open `https://random-words.trycloudflare.com/health` in a browser. You should see `{"ok":true}`.
4. **Point your Twilio number at it** (one command instead of clicking through the Console):
   ```
   npm run twilio:setup             # shows what would change
   npm run twilio:setup -- --apply  # changes it
   ```
5. **Put your phone on a practice customer** (once; safe to repeat):
   ```
   npm run demo:setup -- --customer +1YOURPHONEA
   ```
6. **Check everything**:
   ```
   npm run doctor
   ```
   It says `FIX` for anything that will stop a call working, and tells you what to do.
7. **Call your Twilio number from Phone A.**

## The demo script

| Scene | Do this | You should hear |
|---|---|---|
| Greeting and menu | call from Phone A | "Thank you for calling Harborline Insurance" then the menu |
| Voice | say "pay my bill" | it still asks you to log in first |
| Login + billing | press **3**, then type your date of birth (default `03141985`) | your balance, in words ("eighty-seven dollars and fifty cents"), and the due date |
| Policy + text | press **1**, then **2** | "I have texted your ID card..." (only really sent if texting is set up; otherwise logged) |
| Claim | press **2**, then **1**; answer the questions; leave a description | a claim reference number read digit by digit; "will be recorded" before the beep |
| Injury claim | same, but answer **1** to "was anyone injured" | the 9-1-1 message, then Phone B rings |
| Agent + whisper | press **0** (or say "talk to someone") | Phone B rings; the person who answers hears a private summary before you are connected |
| Wait + callback | while Phone B is busy, call again and press 0 | "You are next in line" and the offer of a call back |
| Stop calling me | say "stop calling me" and confirm | you are put on the do-not-call list |

For extra scenes read the lesson for that phase (payments needs the test-mode setup; outbound has its own checkpoint).

### Getting the tunnel tool

Download Cloudflare's official `cloudflared` for Windows from
`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe`
and save it as `tools/cloudflared.exe` inside this project (the `tools` folder is git-ignored). Any other tunnel works too (for example ngrok, which needs a free account); all that matters is a public https address that forwards to port 3000.

## If something goes wrong

| What you see | Most likely cause | Fix |
|---|---|---|
| Twilio says "application error" or the call drops right away | the server is not running, or the tunnel address changed | restart the tunnel, restart the server with the new address, run `npm run twilio:setup -- --apply` |
| The server log shows `signature_mismatch` (HTTP 403) | `PUBLIC_BASE_URL` does not exactly match the address Twilio calls | they must be identical, including `https://` and no trailing path |
| You hear the "closed" menu | outside Mon-Fri 8-6 / Sat 9-1 Eastern | set `HOURS_MODE=always-open` for a demo |
| "I could not verify that information" | the date of birth or number does not match the demo customer | run `npm run demo:setup -- --customer +1... --dob MMDDYYYY` with the number you are calling FROM |
| Phone B never rings | `AGENT_PHONE` unset, or (trial) Phone B not verified | `npm run doctor` |
| You are told "You are number 2" and nobody is on the line | the agent line is marked busy (a call that never reported back) | it clears itself after 30 minutes, or restart the server |
| `npm run doctor` fails on credentials | wrong SID or token | copy them again from the Console home page |

## Reset

```
npm run demo:setup -- --reset      # removes the demo customers (consent and do-not-call records are never deleted)
```
The practice database is the single file `data/harborline.db`. Stop the server and delete that file to start completely fresh.

## Beyond a demo: a stable address

A quick tunnel is fine for a demo and wrong for anything that must stay up. For a fixed address you need a host:

* `npm run build` then `npm run start:prod` runs the compiled server (`NODE_ENV=production`, which ignores the demo `NOW_OVERRIDE`).
* The included `Dockerfile` builds a container for any host that runs containers (**not tested here**: Docker was not available on the machine I built this on).
* **Two things to know before you put it on a host:**
  * The database is a **file**. On a host with a temporary disk it is erased on every deploy, so give it a persistent volume at `/app/data` (or wait for Phase 10, which moves state to a real database and Redis).
  * Call state lives in the server's memory, so **run exactly one copy** and expect a restart to drop calls in progress. Phase 10 fixes this.
* Set `PUBLIC_BASE_URL` to the host's https address, run `npm run twilio:setup -- --apply` once, and the number never needs touching again.
