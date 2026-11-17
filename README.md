# Toolbelt 1.1.0

Six tools in one Chrome/Chromium Manifest V3 extension: Translate, Delete,
Items, Source, Width, and Link Shower.

## Install or update

1. Extract this ZIP into a permanent folder.
2. Open chrome://extensions and enable Developer mode.
3. Choose Load unpacked and select the extracted folder containing manifest.json.
   To update an existing unpacked Toolbelt, replace its files in the same folder
   and click Reload on its extension card to retain Toolbelt's saved settings.
4. Refresh existing web tabs so the updated page scripts can load.
5. Disable the standalone Link Shower extension to avoid duplicate tooltips.

Standalone Link Shower settings do not transfer automatically between extension IDs.
Open Toolbelt's Links tab to choose your preferences.

## Tools

- Translate: choose a language, translate a page, translate clicked elements,
  or edit text. Escape stops interactive modes.
- Delete: remove single or matching elements, undo the last deletion, or stop.
  These are temporary page changes; reloading restores the original page.
- Items: count Pinterest Pins or Facebook photos, Reels, or posts. Post scanning
  has a configurable cap. Sites can change their markup and break these collectors.
- Source: fetch the current URL's HTML and copy or download it as UTF-8 text.
  This is server HTML, which can differ from the live DOM after page scripts run.
  Existing Philippines/.ph warnings are preserved. Errors appear in the popup.
- Width: set a centered maximum width from 200 to 10000 pixels. Reset restores
  the original inline maximum width and side margins, including priorities.
- Links: Link Shower shows destinations on hover with Hold, Tap, or Always mode;
  configurable trigger key and accent; external links filter; and optional page
  or metadata-card previews. Includes link counts and an enable/disable switch.
  Escape dismisses the current tooltip; typing in fields does not activate it.

Toolbelt remembers the last selected tab. Keyboard shortcuts can be changed at
chrome://extensions/shortcuts: Ctrl+Shift+Z (copy source), Ctrl+Shift+Q (save
source), Ctrl+Shift+D (single delete), Ctrl+Shift+S (scan items).

## Permissions and network behavior

Page access supports link tooltips and tools on the sites you visit. Storage
keeps preferences locally, scripting operates on the active page, and downloads
saves source files. Translation sends page text to Google's Translate endpoint.
Link previews contact destination sites; metadata-card fetches omit cookies.
Live page previews may use the browser's normal cookie behavior. Turn previews
off for URL-only tooltips, or disable Link Shower entirely with its switch.

As in the supplied Link Shower, declarativeNetRequest removes frame-blocking
response headers only for subframes initiated by this extension's preview page.
Embedded previews are sandboxed. Some sites still cannot be previewed, especially
sites requiring sign-in or blocking embedded views. Chrome internal pages, the
Chrome Web Store, and other restricted pages cannot run these page tools.
File URLs require Chrome's separate Allow access to file URLs setting.

## Changes in 1.1.0

- Integrated Link Shower as the sixth hub tab, with namespaced messages, settings,
  and scoped styles to avoid conflicts with other Toolbelt tools.
- Added enable switch, Escape dismissal, reliable preview timeout handling,
  bounded image loading, request deduplication, and safer metadata decoding.
- Fixed source saving for Manifest V3 service workers (removed FileReader).
  Copy/save now report success or failure instead of optimistic confirmation.
- Width reset restores original styles rather than deleting them. Width values
  are checked both in the popup and service worker.
- Added visible keyboard focus and remembered hub-tab selection.

## Validation

JavaScript syntax and manifest resource references checked. Automated Chromium
checks with mocked extension APIs cover all six popup tabs, preferences, trigger
key capture, counts, layout, width validation, copy/save error feedback, hover
activation, Escape, and unrelated storage updates. Regression checks cover width
style restoration and UTF-8 download generation. Full unpacked-extension loading
was blocked by this environment's browser policy, so real extension permissions,
live translation, third-party previews, and current Pinterest/Facebook collectors
still need a check in your browser after installation.
