// Wait for assets before visual comparison; lazy-image timing is not a UI change.
export async function snapshot(page, options) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = [...document.images];
    images.forEach(img => { img.loading = 'eager'; });
    await Promise.all(images.map(img => img.decode().catch(() => {})));
  });
  return page.screenshot({animations: "disabled", ...options});
}
