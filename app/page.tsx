10:41:27.360 Running build in Washington, D.C., USA (East) – iad1
10:41:27.361 Build machine configuration: 2 cores, 8 GB
10:41:27.578 Cloning github.com/amhamza125/collateral-guard-ui (Branch: main, Commit: 4cc89bc)
10:41:28.245 Cloning completed: 666.000ms
10:41:29.140 Restored build cache from previous deployment (2AEjoAEYDyjmmWuQXD6cAuyMpkf9)
10:41:30.002 Running "vercel build"
10:41:30.019 Vercel CLI 62.1.0
10:41:30.309 Installing dependencies...
10:41:36.650 
10:41:36.651 up to date in 6s
10:41:36.653 
10:41:36.654 161 packages are looking for funding
10:41:36.654   run `npm fund` for details
10:41:36.654 npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
10:41:36.655 npm warn install-scripts   unrs-resolver@1.12.2 (postinstall: node postinstall.js)
10:41:36.655 npm warn install-scripts
10:41:36.655 npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
10:41:36.706 Detected Next.js version: 16.3.8
10:41:36.717 Running "npm run build"
10:41:36.919 
10:41:36.919 > collateral-guard-ui@0.1.0 build
10:41:36.919 > next build
10:41:36.919 
10:41:37.653 ▲ Next.js 16.3.8 (Turbopack)
10:41:38.031   Applying modifyConfig from Vercel
10:41:38.033 ✓ Running next.config.ts took 379ms
10:41:38.055 
10:41:38.108   Creating an optimized production build ...
10:41:44.312 ✓ Compiled successfully in 5.2s
10:41:44.317   Running TypeScript ...
10:41:49.688 app/page.tsx(264,11): error TS2322: Type 'unknown[]' is not assignable to type 'CalldataEncodable[]'.
10:41:49.689   Type 'unknown' is not assignable to type 'CalldataEncodable'.
10:41:49.689 app/page.tsx(265,11): error TS2322: Type 'number' is not assignable to type 'bigint'.
10:41:49.737 Failed to type check.
10:41:49.738 
10:41:49.818 Error: Command "npm run build" exited with 1
