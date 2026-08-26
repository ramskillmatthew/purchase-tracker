// The Chrome extension (vinted-draft-queue-extension/) is deliberately
// plain JavaScript with no build step — see that folder's own README for
// why (packaged, unbundled extension code). This project's tsconfig has
// allowJs: false (a deliberate TypeScript-only convention for the app
// itself), so importing one of those .js modules directly from a .ts test
// file has no type information to check against. This ambient shorthand
// module declaration tells TypeScript to treat any .js import as `any`
// (both default and named bindings) rather than erroring — scoped to
// nothing else in this repo, since nothing else imports a .js file from a
// .ts file.
declare module "*.js";
