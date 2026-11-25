"""Run with python tests/instagram_overlay.py after installing Playwright and Chromium."""

from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SEARCH_URL = "https://www.instagram.com/explore/search/"
GRID = """
<style>
  video { width: 180px; height: 150px; background: gray; }
  #viewer { position: fixed; inset: 0; background: #0009; place-content: center; }
  #viewer:not([hidden]) { display: grid; }
  #viewer[role=dialog] { left: 40%; }
  #viewer video { width: 360px; height: 300px; }
</style>
<main>
  <a href="/p/FirstTile/"><video></video></a>
  <div role="button"><video></video></div>
</main>
<section id="viewer" role="dialog" hidden></section>
<script>
  window.addEventListener('message', ({data}) => {
    if (data?.type === 'FBDL_IG_GET_VIDEO') window.requestedVideo = data;
  });
</script>
"""


def test_search_viewer():
    with TemporaryDirectory() as profile, sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
        )
        try:
            context.route("**/*", lambda route: route.abort())
            page = context.new_page()
            page.route(SEARCH_URL, lambda route: route.fulfill(content_type="text/html", body=GRID))
            page.goto(SEARCH_URL)
            buttons = page.locator("#fbdl-overlay button:visible")
            viewer = page.locator("#viewer")
            expect(buttons).to_have_count(2)

            viewer.evaluate("""el => {
              history.pushState(null, '', '/p/FirstTile/');
              el.hidden = false;
            }""")
            expect(buttons).to_have_count(0)
            viewer.evaluate("""el => {
              const video = document.createElement('video');
              video.poster = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
              el.appendChild(video);
            }""")
            expect(buttons).to_have_count(1)

            # A sheet can stack above the viewer even when it appears earlier in the DOM.
            viewer.evaluate("""el => el.insertAdjacentHTML('beforebegin',
              '<div id="sheet" role="dialog" style="position:fixed;inset:0;z-index:1"></div>')""")
            expect(buttons).to_have_count(0)
            page.locator("#sheet").evaluate("el => el.remove()")
            expect(buttons).to_have_count(1)

            # Some viewers cover the grid without marking it inert or using a dialog role.
            viewer.evaluate("""async el => {
              el.removeAttribute('role');
              document.querySelector('main').setAttribute('role', 'dialog');
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            }""")
            expect(buttons).to_have_count(1)
            buttons.click()
            page.wait_for_function("""() => window.requestedVideo?.code === 'FirstTile' &&
              window.requestedVideo.singleVideo &&
              window.requestedVideo.posters.includes(document.querySelector('#viewer video').poster)""")

            viewer.evaluate("el => { el.hidden = true; history.back(); }")
            expect(buttons).to_have_count(2)
            page.wait_for_url(SEARCH_URL)

            # A preloaded player can open through a visibility change alone.
            viewer.evaluate("""async el => {
              el.setAttribute('aria-modal', 'true');
              el.replaceChildren(document.createElement('video'));
              await new Promise(requestAnimationFrame);
              el.hidden = false;
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            }""")
            assert buttons.count() == 1
            viewer.evaluate("el => el.hidden = true")
            expect(buttons).to_have_count(2)

            page.evaluate("""() => {
              const dialog = document.createElement('dialog');
              dialog.innerHTML = '<video></video>';
              document.body.appendChild(dialog);
              dialog.showModal();
            }""")
            expect(page.locator("dialog #fbdl-overlay button:visible")).to_have_count(1)
            expect(buttons).to_have_count(1)
            buttons.click(trial=True)
            page.locator("dialog").evaluate("el => el.close()")
            expect(buttons).to_have_count(2)
        finally:
            context.close()


if __name__ == "__main__":
    test_search_viewer()
