"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0xD914f1eC67f29B0eA078A0A8d32b3c0461504754";

// Exact ABI corresponding to your CollateralGuard.py functions
const CONTRACT_ABI = [
  "function add_monitored_account(string account_address, uint256 collateral_amount, uint256 debt_amount, string collateral_asset, string debt_asset)",
  "function check_and_protect(string account_address)",
  "function get_position_status(string account_address) view returns (string)",
  "function unpause_protocol()"
];

interface Position {
  address: string;
  collateralAmount: number;
  debtAmount: number;
  collateralAsset: string;
  debtAsset: string;
  thresholdPercent: number;
  currentRatio: number;
  status: "SAFE" | "WARNING" | "CRITICAL";
}

export default function CollateralGuardDashboard() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [protocolPaused, setProtocolPaused] = useState<boolean>(false);
  const [globalThreshold] = useState<number>(150);
  
  // Real-Time Prices via API
  const [oraclePrices, setOraclePrices] = useState<Record<string, number>>({
    WETH: 3200, WBTC: 64500, SOL: 145, USDC: 1, USDT: 1
  });

  const [positions, setPositions] = useState<Position[]>([]);
  
  const [statusLog, setStatusLog] = useState<{ msg: string; type: "info" | "warn" | "danger" | "success"; time: string; hash?: string }[]>([
    { msg: "GenVM ABI Loaded. Awaiting Wallet Connection...", type: "info", time: new Date().toLocaleTimeString() },
  ]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [modalCollateral, setModalCollateral] = useState<string>("");
  const [modalDebt, setModalDebt] = useState<string>("");
  const [modalCollAsset, setModalCollAsset] = useState<string>("WETH");
  const [isTxPending, setIsTxPending] = useState<boolean>(false);

  // Fetch Live Prices from CoinGecko
  useEffect(() => {
    const fetchLivePrices = async () => {
      try {
        const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,solana&vs_currencies=usd");
        const data = await res.json();
        setOraclePrices({
          WETH: data.ethereum.usd,
          WBTC: data.bitcoin.usd,
          SOL: data.solana.usd,
          USDC: 1,
          USDT: 1
        });
      } catch (err) {
        console.error("Price fetch failed.");
      }
    };
    fetchLivePrices();
    const interval = setInterval(fetchLivePrices, 30000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [statusLog]);

  const addLog = (msg: string, type: "info" | "warn" | "danger" | "success" = "info", hash?: string) => {
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setStatusLog((prev) => [...prev, { msg, type, time: timeStr, hash }]);
  };

  // --- 1. CONNECT & FETCH REAL STATE ---
  const connectWallet = async () => {
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        setIsConnecting(true);
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        await provider.send("eth_requestAccounts", []);
        const signer = await provider.getSigner();
        const address = await signer.getAddress();
        setWalletAddress(address);
        addLog(`Wallet Connected: ${address}`, "success");
        
        // Fetch Real Contract State
        await fetchPositionFromContract(address, provider);
      } catch (err) {
        addLog("Wallet connection rejected.", "danger");
      } finally {
        setIsConnecting(false);
      }
    } else {
      alert("Please install MetaMask to connect.");
    }
  };

  const fetchPositionFromContract = async (address: string, provider: any) => {
    try {
      addLog(`Querying GenLayer state for ${address.slice(0,6)}...`, "info");
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
      const posJsonStr = await contract.get_position_status(address);
      
      if (posJsonStr && posJsonStr !== "NOT_FOUND") {
        const posData = JSON.parse(posJsonStr);
        // Reverse the SCALE (10**18) mapping from the contract
        const collParsed = parseFloat(ethers.formatUnits(posData.collateral_amount, 18));
        const debtParsed = parseFloat(ethers.formatUnits(posData.debt_amount, 18));
        
        // Local math for UI display
        const collValue = collParsed * (oraclePrices[posData.collateral_asset] || 3200);
        const debtValue = debtParsed * 1;
        const ratio = debtValue === 0 ? 0 : (collValue / debtValue) * 100;
        const status = ratio < globalThreshold ? "CRITICAL" : ratio < globalThreshold + 15 ? "WARNING" : "SAFE";

        setPositions([{
          address: address,
          collateralAmount: collParsed,
          debtAmount: debtParsed,
          collateralAsset: posData.collateral_asset,
          debtAsset: posData.debt_asset,
          thresholdPercent: globalThreshold,
          currentRatio: parseFloat(ratio.toFixed(1)),
          status
        }]);
        addLog(`State synced from contract successfully.`, "success");
      } else {
        addLog(`No active position found in contract state.`, "warn");
      }
    } catch (err: any) {
      console.error(err);
      addLog(`Failed to read contract state. Check RPC connection.`, "danger");
    }
  };

  // --- 2. ADD FUNDS (REAL TX) ---
  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress) return alert("Connect wallet first!");
    
    try {
      setIsTxPending(true);
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      
      // Scale amounts by 10**18 to match your Python SCALE variable
      const collScaled = ethers.parseUnits(modalCollateral, 18);
      const debtScaled = ethers.parseUnits(modalDebt, 18);

      addLog(`Executing add_monitored_account() on-chain...`, "info");
      
      // THIS OPENS METAMASK WITH THE REAL FUNCTION CALL
      const tx = await contract.add_monitored_account(
        walletAddress, 
        collScaled, 
        debtScaled, 
        modalCollAsset, 
        "USDC",
        { gasLimit: 5000000 } // Ensures GenLayer doesn't fail on gas estimation
      );
      
      addLog(`TX Sent! Awaiting confirmation...`, "warn", tx.hash);
      const receipt = await tx.wait();
      addLog(`Position committed in Block ${receipt.blockNumber}. Syncing state...`, "success");
      
      await fetchPositionFromContract(walletAddress, provider);
      setShowAddModal(false);
      setModalCollateral("");
      setModalDebt("");
    } catch (error: any) {
      const msg = error.reason || error.message || "Unknown error";
      addLog(`Transaction Failed/Reverted: ${msg.slice(0,80)}`, "danger");
    } finally {
      setIsTxPending(false);
    }
  };

  // --- 3. RUN SENTINEL (CATCHING REAL EXCEPTIONS) ---
  const handleCheckAndProtect = async (targetAddr: string) => {
    if (!walletAddress) return alert("Connect wallet first!");
    
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      
      addLog(`Firing check_and_protect() for ${targetAddr.slice(0,6)}...`, "info");
      
      // Execute the real contract method
      const tx = await contract.check_and_protect(targetAddr, { gasLimit: 8000000 });
      addLog(`TX Broadcasted! AI Consensus running...`, "warn", tx.hash);
      
      await tx.wait();
      
      // If it DOESN'T revert, it means it hit the "CRITICAL" pause logic
      setProtocolPaused(true);
      addLog(`CRITICAL BREACH: Transaction succeeded, Protocol Paused!`, "danger");

    } catch (error: any) {
      // GENVM THROWS EXCEPTIONS FOR SAFE AND WARNING - WE CATCH THEM HERE TO PROVE IT WORKS!
      const errorDump = JSON.stringify(error);
      
      if (errorDump.includes("RATIO_SAFE_CONDITION_HELD")) {
        addLog(`[ON-CHAIN AI RESULT]: SAFE. Position is mathematically sound.`, "success");
      } else if (errorDump.includes("RATIO_WARNING_CONDITION")) {
        addLog(`[ON-CHAIN AI RESULT]: WARNING. Approaching threshold or bad news detected.`, "warn");
      } else if (errorDump.includes("PROTOCOL_ALREADY_PAUSED")) {
        addLog(`[ON-CHAIN RESULT]: REVERTED. Protocol is currently paused.`, "danger");
      } else {
        const msg = error.reason || "Execution Reverted by GenVM";
        addLog(`Contract Error: ${msg.slice(0, 80)}`, "danger");
      }
    }
  };

  const totalMonitoredValue = useMemo(() => {
    return positions.reduce((sum, pos) => sum + (pos.collateralAmount * (oraclePrices[pos.collateralAsset] || 0)), 0);
  }, [positions, oraclePrices]);

  return (
    <div className="flex h-screen bg-[#070b14] text-slate-100 font-sans overflow-hidden">
      
      {/* LEFT SIDEBAR */}
      <aside className="w-64 bg-[#0d1322] border-r border-slate-800/60 flex flex-col justify-between shrink-0">
        <div>
          <div className="p-6 flex items-center space-x-3 border-b border-slate-800/40">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold tracking-wider text-white">GENLAYER</h1>
              <p className="text-[10px] tracking-widest text-blue-400 font-mono">SENTINEL GUARD</p>
            </div>
          </div>
          <nav className="p-4 space-y-1">
            <button className="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium bg-blue-600/15 text-blue-400 border border-blue-500/20 shadow-sm">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
              <span>Dashboard</span>
            </button>
          </nav>
        </div>
        <div className="p-4 m-4 rounded-xl bg-gradient-to-br from-blue-950/40 to-slate-900 border border-blue-800/30">
          <div className="flex items-center space-x-2 text-xs text-blue-400 font-semibold mb-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>TESTNET RPC LIVE</span>
          </div>
          <p className="text-[11px] text-slate-400 font-mono break-all">{CONTRACT_ADDRESS}</p>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col overflow-y-auto">
        
        <header className="h-16 border-b border-slate-800/60 px-8 flex items-center justify-between bg-[#0b101b]/80 backdrop-blur shrink-0 sticky top-0 z-10">
          <div>
            <h2 className="text-lg font-semibold text-white">CollateralGuard Sentinel</h2>
          </div>
          <div className="flex items-center space-x-4">
            <div className={`px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center space-x-1.5 ${
              protocolPaused ? "bg-red-500/10 text-red-400 border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            }`}>
              <span className={`w-2 h-2 rounded-full ${protocolPaused ? "bg-red-400" : "bg-emerald-400"}`}></span>
              <span>{protocolPaused ? "PAUSED (CIRCUIT TRIPPED)" : "ACTIVE GUARD"}</span>
            </div>
            {!walletAddress ? (
              <button onClick={connectWallet} disabled={isConnecting} className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 px-4 rounded-lg shadow-sm shadow-blue-500/20">
                {isConnecting ? "Connecting..." : "Connect Wallet"}
              </button>
            ) : (
              <div className="bg-slate-800 border border-slate-700 text-white text-xs font-mono py-2 px-4 rounded-lg">
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </div>
            )}
          </div>
        </header>

        <div className="p-8 space-y-6 max-w-7xl">
          
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl">
              <p className="text-xs font-medium text-slate-400">Total Monitored Value</p>
              <h3 className="text-2xl font-bold text-white mt-1">${totalMonitoredValue.toLocaleString(undefined, {minimumFractionDigits: 2})}</h3>
              <div className="mt-3 text-[10px] text-slate-500 font-mono">Live CoinGecko Oracle Sync</div>
            </div>

            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl">
              <p className="text-xs font-medium text-slate-400">Liquidation Threshold</p>
              <h3 className="text-2xl font-bold text-white mt-1">{globalThreshold}%</h3>
              <div className="mt-3 text-[10px] text-slate-400 font-mono">Scaled: 1.5 × 10¹⁸</div>
            </div>

            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl">
              <p className="text-xs font-medium text-slate-400">Live Asset Prices</p>
              <div className="mt-2 space-y-1 text-xs font-mono">
                <div className="flex justify-between text-slate-300"><span>WETH</span><span className="text-white">${oraclePrices.WETH.toLocaleString()}</span></div>
                <div className="flex justify-between text-slate-300"><span>WBTC</span><span className="text-white">${oraclePrices.WBTC.toLocaleString()}</span></div>
                <div className="flex justify-between text-slate-300"><span>SOL</span><span className="text-white">${oraclePrices.SOL.toLocaleString()}</span></div>
              </div>
            </div>

            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl flex flex-col justify-between">
              <p className="text-xs font-medium text-slate-400 mb-2">Protocol Controls</p>
              <div className="grid grid-cols-1 gap-2">
                <button onClick={() => { if (!walletAddress) { alert("Connect wallet first!"); return; } setShowAddModal(true); }} className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold py-2.5 rounded-xl transition-all shadow-sm shadow-blue-500/20">
                  + Add Account
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-sm font-semibold text-white">Monitored Positions</h4>
                  <p className="text-xs text-slate-400">GenLayer TreeMap State</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                {positions.length === 0 ? (
                  <div className="h-32 flex flex-col items-center justify-center text-slate-500">
                    <p className="text-sm">No positions found. Connect wallet to read state.</p>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-400 border-b border-slate-800 font-mono">
                      <tr>
                        <th className="pb-3">Account</th>
                        <th className="pb-3">Assets</th>
                        <th className="pb-3">Ratio</th>
                        <th className="pb-3">Status</th>
                        <th className="pb-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {positions.map((pos, idx) => (
                        <tr key={idx} className="hover:bg-slate-900/40 transition-colors">
                          <td className="py-3.5 font-semibold text-slate-200">{pos.address.slice(0,6)}...{pos.address.slice(-4)}</td>
                          <td className="py-3.5 text-slate-300">{pos.collateralAmount} {pos.collateralAsset} <br/> <span className="text-slate-500 text-[10px]">Debt: {pos.debtAmount}</span></td>
                          <td className="py-3.5 font-bold text-white">{pos.currentRatio}%</td>
                          <td className="py-3.5">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              pos.status === "CRITICAL" ? "bg-red-500/20 text-red-400 border border-red-500/40"
                              : pos.status === "WARNING" ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                              : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                            }`}>
                              {pos.status}
                            </span>
                          </td>
                          <td className="py-3.5 text-right">
                            <button onClick={() => handleCheckAndProtect(pos.address)} className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs transition-all shadow-md">
                              Run check_and_protect()
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* REAL-TIME TERMINAL LOGS */}
            <div className="lg:col-span-4 bg-[#0a0f18] border border-slate-800/80 rounded-2xl overflow-hidden flex flex-col h-72 shadow-inner shadow-black/50">
              <div className="bg-[#111827] px-4 py-2 border-b border-slate-800 flex items-center space-x-2">
                <div className="flex space-x-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></div>
                </div>
                <span className="text-[10px] text-slate-500 font-mono ml-2">genvm-node-execution.log</span>
              </div>
              <div className="p-4 flex-1 overflow-y-auto font-mono text-[11px] space-y-3">
                {statusLog.map((log, i) => (
                  <div key={i} className="flex flex-col space-y-1">
                    <div className="flex space-x-2">
                      <span className="text-slate-600 shrink-0">[{log.time}]</span>
                      <span className={`${
                        log.type === "danger" ? "text-red-400" 
                        : log.type === "warn" ? "text-amber-400" 
                        : log.type === "success" ? "text-emerald-400" 
                        : "text-blue-300"
                      }`}>
                        {log.msg}
                      </span>
                    </div>
                    {/* Live Explorer Link Generation */}
                    {log.hash && (
                      <div className="ml-16 flex items-center text-slate-500 space-x-1">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        <a href={`https://explorer.genlayer.com/tx/${log.hash}`} target="_blank" rel="noreferrer" className="hover:text-blue-400 underline decoration-slate-700 decoration-dotted">
                          {log.hash.slice(0,20)}...
                        </a>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* REAL METAMASK ADD FUNDS MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#0f1627] border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-base font-bold text-white">Execute add_monitored_account</h3>
            <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] p-2 rounded flex space-x-2 items-center">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <span>Only the Wallet that deployed the contract can call this (self._require_owner).</span>
            </div>
            <form onSubmit={handleAddAccount} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-mono text-slate-400">Asset</label>
                  <select value={modalCollAsset} onChange={(e) => setModalCollAsset(e.target.value)} className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white outline-none focus:border-blue-500">
                    <option value="WETH">WETH (${oraclePrices.WETH.toLocaleString()})</option>
                    <option value="WBTC">WBTC (${oraclePrices.WBTC.toLocaleString()})</option>
                    <option value="SOL">SOL (${oraclePrices.SOL.toLocaleString()})</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-mono text-slate-400">Deposit Amount</label>
                  <input type="number" step="any" required placeholder="10" value={modalCollateral} onChange={(e) => setModalCollateral(e.target.value)} className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white outline-none focus:border-blue-500"/>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-mono text-slate-400">Debt Asset</label>
                  <input type="text" disabled value="USDC ($1.00)" className="w-full mt-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-500 cursor-not-allowed"/>
                </div>
                <div>
                  <label className="text-[11px] font-mono text-slate-400">Borrow Amount</label>
                  <input type="number" step="any" required placeholder="5000" value={modalDebt} onChange={(e) => setModalDebt(e.target.value)} className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white outline-none focus:border-blue-500"/>
                </div>
              </div>
              <div className="flex justify-end space-x-2 pt-2">
                <button type="button" onClick={() => setShowAddModal(false)} disabled={isTxPending} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300">
                  Cancel
                </button>
                <button type="submit" disabled={isTxPending} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-semibold rounded-xl text-white">
                  {isTxPending ? "Awaiting MetaMask..." : "Sign Transaction"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
