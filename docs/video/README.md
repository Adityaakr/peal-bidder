# The Peal Bidder video

The submission video for QoreChain "Build Before Q-Day" (Post-Quantum AI Agents category):
a 2:44 narrated walkthrough of the product working, 1920x1080 at 30 fps. This folder holds its
source; the rendered file, the screenshots and the voice are not committed (they are rebuilt
from the steps below).

Every screen in it is the real site, captured from the production build against the public
testnet on 21 November 2026: the live agent's receipts verified in the browser, the owner's key
and spending rule read from the chain, and a guest agent sealing a bid to the auction's real
2-of-3 committee and refusing the attacks. The audit scene shows the real output of
`pnpm agent audit --published` from that day (8 of 8 transactions agree). Only public addresses
and transaction hashes appear; no key, recovery phrase or API key is shown or spoken.

| File | What |
| --- | --- |
| [`src/voice/s1.txt` … `s9.txt`](src/voice) | The narration, one file per scene, as Kokoro speaks it ("Core Chain", "M L D S A eighty-seven") |
| [`src/voice/assemble.py`](src/voice/assemble.py) | Lays the nine clips on one track and writes the scene timings |
| [`src/scenes/`](src/scenes) | The nine scenes (HTML + GSAP), each timed to its narration |
| [`src/build.mjs`](src/build.mjs) | Writes the HyperFrames project (`index.html`, `compositions/`) from `src/` |
| [`src/common.css`](src/common.css), [`src/helpers.js`](src/helpers.js), [`src/fonts.css`](src/fonts.css) | The Bidder's tokens (`apps/web/DESIGN.md`), the camera and focus-frame helpers, the IBM Plex faces |
| [`src/capture.mjs`](src/capture.mjs) | Screenshots of the real site at 2x, and where each row sits on them |
| [`src/audio.json`](src/audio.json) | The voice track and the film's length |

## What the film shows, in order

1. **The problem** (0:00): the landing page's "An agent with a wallet is a key anyone can talk
   to", then the hero: "An AI agent that spends inside lines it cannot cross."
2. **The mandate** (0:14): the live agent's first mandate, field by field: signed with
   ML-DSA-87, sealed with ML-KEM-1024, budget, most per bid, highest tick, expiry.
3. **Four checks** (0:34): the owner's key on chain, Claude Opus 5.5 planning with auction text
   as data, the policy clamp, the chain's spending rule.
4. **The live agent** (0:56): 21 receipts verified in the browser; Claude's plan; the injected
   "ignore your mandate" it disregarded; the forged mandate the agent refused.
5. **The chain held the line** (1:16): the daily-limit refusal (`B1E1DAD2…`), the per-bid refusal
   with the policy bypassed (`4012FE2E…`), three bids landed and claimed (44.65 PEAL-T).
6. **Your own agent** (1:33): a guest account in the browser, a mandate signed, each check lit,
   the bid sealed to the real committee, nothing sent.
7. **Try to break it** (1:50): a forged mandate (SIGNATURE_INVALID), a replay (REPLAYED), an
   injected plan clamped by the policy, and the signed receipts.
8. **Audited against the chain** (2:09): `pnpm agent audit --published`, 8 of 8 with each hybrid
   ML-DSA-87 signature verified; the category's requirements with their evidence.
9. **Outro** (2:29): the lockup, the line, the repository and the Peal family.

## Rebuild it

Needs Node.js 22, ffmpeg, Python 3 and the HyperFrames CLI (0.9.58 or later). Work in a scratch
folder outside the repository, since the media is large.

```sh
npx hyperframes init film --skip-skills         # a HyperFrames project
cp -R docs/video/src film/src
# Assets the source expects, under film/assets/:
#   brand/   lockup.svg and mark.svg from apps/web/public/brand/bidder/;
#            auction-mark.svg and tender-mark.svg from apps/web/public/brand/auction|tender/mark.svg
#   fonts/   IBM Plex Sans 400/500/600, Plex Sans Condensed 600, Plex Mono 400/500 as woff2,
#            named as in src/fonts.css (Google Fonts, OFL)
#   shots/   the real screens: in the repository, `pnpm web:build && pnpm web:preview --port 4931`,
#            then OUT=<film>/assets/shots node docs/video/src/capture.mjs
#   vo/ and voiceover.wav:
#            for i in 1 2 3 4 5 6 7 8 9; do npx hyperframes tts src/voice/s$i.txt -v af_heart -o assets/vo/s$i.wav; done
#            python3 src/voice/assemble.py 1.4 0.8 164
cd film && node src/build.mjs && npx hyperframes check && npx hyperframes render --quality delivery -o ../peal-bidder.mp4
```

The voice is Kokoro-82M (`af_heart`) on the local machine through `npx hyperframes tts`; it
needs the `kokoro-onnx` Python package (`HYPERFRAMES_PYTHON` can point at a venv that has it).
The screens are live, so a recapture on another day shows that day's guest account and
receipt times; the scene frames follow `rects.json`, which `capture.mjs` writes beside the shots.
There is no music bed: no licensed track was at hand, and the narration carries the film.

The cover image for the project page, [`docs/cover/peal-bidder-cover.png`](../cover/peal-bidder-cover.png)
(1920x1080), is the film's last frame.

Made with HyperFrames by a worker agent, on the pipeline Peal Tender's video used; see
[AI_USAGE.md](../../AI_USAGE.md).
