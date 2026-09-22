/**
 * "Theme tokens come from docs/spec/visuals/theme.css... Light and dark
 * follow prefers-color-scheme." theme.css itself only defines `:root`
 * (light) and a `[data-theme="dark"]` override — there is no
 * `prefers-color-scheme` media query in the canonical file (never edited
 * here; see scripts/copy-static-assets.mjs), so this sets the
 * `data-theme` attribute the dark rule targets, driven by the OS
 * preference, and keeps it live as that preference changes.
 *
 * Called first thing by every page entry point, before rendering anything,
 * so there is no flash of the wrong theme.
 */
export function applyColorScheme(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const apply = () => {
    document.documentElement.dataset.theme = media.matches ? "dark" : "light";
  };

  apply();
  media.addEventListener("change", apply);
}
