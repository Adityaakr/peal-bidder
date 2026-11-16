# Peal Bidder: design

The Bidder's own identity. What the three Peal entries share (the family line in the
footer, the mark construction, voice, evidence, accessibility, wallets, what is out) is
in Peal Tender's [`docs/design.md`](https://github.com/Adityaakr/peal-tender/blob/main/docs/design.md).
Everything below belongs to this product only.

## Concept

- **The visitor:** a judge or a builder deciding whether an AI agent can be trusted with
  money. They know wallets and LLMs and are sceptical of both.
- **The idea in five seconds:** this agent spends, but only inside lines it cannot cross,
  and you can watch it.
- **The metaphor:** the agent on a leash. The leash is a hard red limit line. The place
  you watch from is an operator console that replays the agent's own signed receipts. The
  mandate appears as what it is: a signed document, field by field.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| page | `#f3f5f6` | instrument grey, flat, everywhere |
| surface | `#ffffff` | tables, diagrams, inputs, the app's cards |
| ink | `#0b1320` (secondary `#3a4656`, muted `#667180`) | text, diagram strokes |
| rule | `#dde2e6` (strong `#c7ced5`) | hairlines |
| accent | `#0369a1` | the agent's signed path, links, primary buttons, focus |
| limit red | `#c9261c` | limits and refusals only: the leash line, refused rows, hard stops |
| green | `#12804a` | landed, accepted, verified |
| console | `#0d141c` with `#e3e8ee` text | the one dark surface: the console |

Red never decorates. Wherever red appears, it marks a limit or something stopped at one.

## Type

- **Display:** IBM Plex Sans Condensed 600. The hero runs 72px over two lines, section
  titles are 44px (32px on a phone), and tracking is slightly tight.
- **Text:** IBM Plex Sans 400/500/600, 16px body and 19px leads.
- **Data:** IBM Plex Mono 400/500/600. It sets the console, hashes, figures, section
  labels and diagram labels.
- **The wordmark:** Inter 600, 17px.

The pairing comes from the console: one family in three widths, so data and prose read
as one instrument.

## Signature pieces

- **The leash line:** the headline phrase "lines it cannot cross" sits on a 4px red
  underline. The same red line marks the end of the console's budget meter and the top
  edge of the spending rule in the schematic.
- **The console:** the live agent's receipts as a log, with time, kind, detail and
  status. Refusals carry a red left edge. A budget meter runs against its limit. The
  footer shows the receipts' ML-DSA-87 check run in the page.
- **The signed mandate:** the real mandate (receipt #0) with line numbers. Numbered
  callouts give the four layers that enforce each field.
- **The diagrams.** They are the backbone of the page, and each answers one question a
  visitor has:
  - *Why not just give an agent a wallet?* The same flow drawn twice, a hot wallet
    against Peal Bidder.
  - *Who holds which key?* Four places with their keys, and what a thief of the agent's
    machine gets.
  - *What happens when it bids?* A sequence diagram across Owner, Agent, Claude,
    Relayer, QoreChain and the auction. The four steps above it highlight their
    messages.
  - *Where does each attack stop?* A track per attacker across the four layers, with a
    red stop at the first layer that refuses it and the proof beside it.

  They share one style: white boxes, an ink stroke, labels in Plex Mono, the signed path
  in the accent and refusals as short thick red stops. Wide drawings scroll inside their
  own frame on a phone; the key map and the attack map reflow.
- **The run table:** the live run as data, with UTC time, event, checker, result, block
  and transaction. On a phone each row becomes a stacked record.

## Motion

- The console lines arrive once, 140ms apart.
- The budget meter fills once.
- The step list highlights its part of the sequence diagram on hover, focus or click.
- Nothing loops. With `prefers-reduced-motion: reduce` the page is complete and still.

## Layout

- A 1200px container on 12 columns. Gutters are 32px, 24px on a tablet and 20px on a
  phone.
- Sections open on a hairline rule with a monospace label.
- Text sits in 5 columns against 7 for a console, a document, a drawing or a table.
- The hero breaks that rule on purpose: the headline spans the width and the console
  sits beside the lead.

## Page order

The page follows the questions a judge asks, in the order they ask them:

1. What it is: the hero and the console.
2. Whether it is live: the figure row.
3. The problem.
4. Who holds which key.
5. The mandate.
6. How a bid happens.
7. Where each attack stops, and the live run.
8. The category's requirements, with evidence.
9. How to try it.
10. The family.
