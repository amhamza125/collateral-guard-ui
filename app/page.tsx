10:45:34.082 Running build in Washington, D.C., USA (East) – iad1
10:45:34.083 Build machine configuration: 2 cores, 8 GB
10:45:34.977 Cloning github.com/amhamza125/collateral-guard-ui (Branch: main, Commit: 4d3970a)
10:45:35.460 Cloning completed: 482.000ms
10:45:36.342 Restored build cache from previous deployment (2AEjoAEYDyjmmWuQXD6cAuyMpkf9)
10:45:37.266 Running "vercel build"
10:45:37.279 Vercel CLI 62.1.0
10:45:38.017 Installing dependencies...
10:45:41.258 
10:45:41.260 up to date in 3s
10:45:41.260 
10:45:41.260 161 packages are looking for funding
10:45:41.260   run `npm fund` for details
10:45:41.260 npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
10:45:41.261 npm warn install-scripts   unrs-resolver@1.12.2 (postinstall: node postinstall.js)
10:45:41.261 npm warn install-scripts
10:45:41.261 npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
10:45:41.305 Detected Next.js version: 16.3.8
10:45:41.313 Running "npm run build"
10:45:41.472 
10:45:41.472 > collateral-guard-ui@0.1.0 build
10:45:41.473 > next build
10:45:41.473 
10:45:42.085 ▲ Next.js 16.3.8 (Turbopack)
10:45:42.510   Applying modifyConfig from Vercel
10:45:42.513 ✓ Running next.config.ts took 427ms
10:45:42.533 
10:45:42.571   Creating an optimized production build ...
10:45:45.892 
10:45:45.892 > Build error occurred
10:45:45.896 Error: Turbopack build failed with 1 error:
10:45:45.896 ./app/page.tsx:528:1
10:45:45.896 Error: Expected '</', got '<eof>'
10:45:45.896   526 |                       <div className="flex items-center justify-between text-[#83888f]">
10:45:45.897   527 |                       
10:45:45.897 > 528 |
10:45:45.897       | ^
10:45:45.897 
10:45:45.897 Parsing ecmascript source code failed
10:45:45.897 
10:45:45.897 
10:45:45.897     at <unknown> (./app/page.tsx:528:1)
10:45:45.966 Error: Command "npm run build" exited with 1
