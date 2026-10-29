# Sourcing Monitor extension

First milestone for the two-monitor Vinted sourcing workflow. Version 0.1 is intentionally **test mode only**: it assigns two Discord monitor tabs plus one inbox tab, observes newly inserted `Buy Now` buttons (including Discord's decorative money emoji), highlights them, de-duplicates by Discord message id, and records high-resolution detection timings. It contains no code that activates a button.

## Load for testing

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked and select this `sourcing-monitor-extension` folder.
4. Open each required Discord page. On each tab, open the extension popup and assign its role.
5. Select **Start test monitoring**.
6. New exact Buy Now controls in Monitor 1 or Monitor 2 will receive a turquoise outline and appear in Latest detections.

The inbox is assigned now so later milestones can add success/failure parsing without changing the operator setup. It performs no message parsing in version 0.1.

## Safety boundary

- No `.click()`, mouse event dispatch, coordinate action, or browser-debugging permission exists in this version.
- Only `https://discord.com/*` is accessible.
- Existing buttons are not scanned on startup; only DOM nodes inserted after monitoring is enabled are considered.
- Only a button or role=button whose normalized accessible label is exactly `Buy Now` can be detected.
