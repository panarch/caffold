// The first element each selector finds below `scope` now, or null, through
// shadow roots as Playwright locators look, for a page function that measures
// several at once.
export function elementHandles(scope, selectors) {
  return Promise.all(
    selectors.map(async (selector) => {
      const found = scope.locator(selector).first();
      return (await found.count()) ? found.elementHandle() : null;
    }),
  );
}
