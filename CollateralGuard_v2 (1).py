# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json

_FALLBACK_PRICES = {"BTC": 64000, "ETH": 3200, "SOL": 150}


class CollateralGuard(gl.Contract):
    global_threshold: bigint
    protocol_paused: bool
    monitored_accounts: TreeMap[str, str]
    check_history: TreeMap[str, str]
    owner: str
    total_checks: bigint
    activity_count: bigint

    def __init__(self):
        self.global_threshold = 150
        self.protocol_paused = False
        self.monitored_accounts = TreeMap[str, str]()
        self.check_history = TreeMap[str, str]()
        self.owner = str(gl.message.sender_address)
        self.total_checks = 0
        self.activity_count = 0

    def _symbol_of(self, asset: str) -> str:
        if "BTC" in asset:
            return "BTC"
        if "ETH" in asset:
            return "ETH"
        if "SOL" in asset:
            return "SOL"
        return "ETH"

    @gl.public.write
    def add_monitored_account(
        self,
        account_address: str,
        collateral_amount: int,
        debt_amount: int,
        collateral_asset: str,
        debt_asset: str,
    ) -> str:
        if collateral_amount <= 0 or debt_amount <= 0:
            raise Exception("INVALID_AMOUNT: collateral and debt must be positive integers")
        if len(account_address) < 8:
            raise Exception("INVALID_ADDRESS")

        self.monitored_accounts[account_address] = json.dumps({
            "collateral_amount": collateral_amount,
            "debt_amount": debt_amount,
            "collateral_asset": collateral_asset,
            "debt_asset": debt_asset,
            "status": "SAFE",
            "last_ratio": 0,
            "ai_sentiment": "N/A",
            "price_source": "N/A",
            "last_message": "Initialized. Awaiting first check().",
            "last_checked": "NEVER",
            "added_by": str(gl.message.sender_address),
        })

        # Record EVERY add in the on-chain activity log — re-adding the same
        # address overwrites the position state, so without this entry the
        # transaction would be invisible in any history view.
        self.activity_count += 1
        seq = str(int(self.activity_count)).zfill(6)
        self.check_history[f"{seq}:{account_address}"] = json.dumps({
            "type": "ADD",
            "account": account_address,
            "asset": collateral_asset,
            "collateral_amount": collateral_amount,
            "debt_amount": debt_amount,
            "debt_asset": debt_asset,
            "message": f"FUNDS_ADDED: {collateral_amount} {collateral_asset} collateral vs {debt_amount} {debt_asset} debt",
        })
        return f"FUNDS_ADDED: {account_address} is now monitored by CollateralGuard."

    @gl.public.write
    def check_and_protect(self, account_address: str) -> str:
        if self.protocol_paused:
            raise Exception("PROTOCOL_PAUSED: circuit breaker is active — the owner must resume first")
        if account_address not in self.monitored_accounts:
            raise Exception("ACCOUNT_NOT_FOUND")

        pos = json.loads(self.monitored_accounts[account_address])
        symbol = self._symbol_of(pos["collateral_asset"])
        collateral_amount = pos["collateral_amount"]
        debt_amount = pos["debt_amount"]
        threshold = self.global_threshold

        def evaluate():
            # Both the price fetch AND the LLM call must live inside this
            # single function so GenVM can trace them as reachable from the
            # consensus mechanism below.
            price = _FALLBACK_PRICES[symbol]
            price_source = "STATIC_FALLBACK"
            used_fallback = False

            # Live price sources in preference order. GenLayer validators
            # could not reach Binance (geo-blocked) in live testing, so each
            # validator walks the chain and uses the first source that
            # answers. Small cross-source price differences are tolerated by
            # the prompt_comparative principle below (the verdict category
            # must match; numeric drift is acceptable).
            if symbol == "BTC":
                coinbase_pair, gecko_id = "BTC-USD", "bitcoin"
            elif symbol == "SOL":
                coinbase_pair, gecko_id = "SOL-USD", "solana"
            else:
                coinbase_pair, gecko_id = "ETH-USD", "ethereum"

            try:
                raw = gl.nondet.web.render(
                    f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}USDT",
                    mode="text",
                )
                price = int(float(json.loads(raw)["price"]))
                price_source = "binance"
            except Exception:
                try:
                    raw = gl.nondet.web.render(
                        f"https://api.coinbase.com/v2/prices/{coinbase_pair}/spot",
                        mode="text",
                    )
                    price = int(float(json.loads(raw)["data"]["amount"]))
                    price_source = "coinbase"
                except Exception:
                    try:
                        raw = gl.nondet.web.render(
                            f"https://api.coingecko.com/api/v3/simple/price?ids={gecko_id}&vs_currencies=usd",
                            mode="text",
                        )
                        price = int(float(json.loads(raw)[gecko_id]["usd"]))
                        price_source = "coingecko"
                    except Exception:
                        used_fallback = True  # surfaced in the verdict — never silent

            collateral_value = collateral_amount * price
            ratio = int((collateral_value * 100) // debt_amount) if debt_amount > 0 else 9999
            breach = ratio < threshold

            prompt = (
                f"DeFi lending position: {collateral_amount} {symbol} collateral against "
                f"${debt_amount} USDT debt. Current collateral ratio is {ratio}% "
                f"(safety threshold {threshold}%). As a risk engine, classify the market "
                f"sentiment for this position. Answer ONLY with the single word "
                f"CATASTROPHIC or NEUTRAL."
            )
            ai_output = gl.nondet.exec_prompt(prompt).strip().upper()
            sentiment = "CATASTROPHIC" if "CATASTROPHIC" in ai_output else "NEUTRAL"

            return json.dumps({
                "ratio": ratio,
                "breach": breach,
                "sentiment": sentiment,
                "price_source": price_source,
                "used_fallback_price": used_fallback,
            }, sort_keys=True)

        agreed = gl.eq_principle.prompt_comparative(
            evaluate,
            principle=(
                "Validators should agree on whether the collateral ratio "
                "breaches the safety threshold (the same breach boolean) and "
                "on the categorical sentiment (CATASTROPHIC or NEUTRAL). The "
                "exact numeric ratio may vary slightly since each validator "
                "independently fetches a live price, possibly from a different "
                "reachable source (Binance, Coinbase or CoinGecko)."
            ),
        )
        data = json.loads(agreed)

        ratio = data["ratio"]
        breach = data["breach"]
        sentiment = data["sentiment"]
        price_source = data["price_source"]
        fallback_note = (
            " [price feed unavailable — used fallback price]"
            if data["used_fallback_price"]
            else f" [price source: {price_source}]"
        )

        self.total_checks += 1

        # Persist state BEFORE returning for every path -- GenVM reverts all
        # state changes if the method raises, so the status / circuit
        # breaker must never depend on an exception being thrown afterward.
        if breach:
            self.protocol_paused = True
            pos["status"] = "CRITICAL"
            pos["ai_sentiment"] = sentiment
            pos["price_source"] = price_source
            pos["last_ratio"] = ratio
            pos["last_checked"] = f"CHECK #{self.total_checks}"
            pos["last_message"] = (
                f"CRITICAL_BREACH: ratio {ratio}% < {threshold}% — "
                f"CIRCUIT_BREAKER_ENGAGED, protocol paused{fallback_note}"
            )
        elif sentiment == "CATASTROPHIC":
            pos["status"] = "WARNING"
            pos["ai_sentiment"] = sentiment
            pos["price_source"] = price_source
            pos["last_ratio"] = ratio
            pos["last_checked"] = f"CHECK #{self.total_checks}"
            pos["last_message"] = (
                f"AI_CONSENSUS_WARNING: ratio {ratio}% held, but AI consensus "
                f"detected catastrophic market sentiment{fallback_note}"
            )
        else:
            pos["status"] = "SAFE"
            pos["ai_sentiment"] = sentiment
            pos["price_source"] = price_source
            pos["last_ratio"] = ratio
            pos["last_checked"] = f"CHECK #{self.total_checks}"
            pos["last_message"] = (
                f"RATIO_SAFE_CONDITION_HELD: ratio {ratio}% is healthy — "
                f"AI sentiment is NEUTRAL{fallback_note}"
            )

        self.monitored_accounts[account_address] = json.dumps(pos)

        # Append to the real on-chain activity log (zero-padded key so
        # lexicographic TreeMap order equals numeric order).
        self.activity_count += 1
        seq = str(int(self.activity_count)).zfill(6)
        self.check_history[f"{seq}:{account_address}"] = json.dumps({
            "type": "CHECK",
            "seq": int(self.total_checks),
            "account": account_address,
            "asset": pos["collateral_asset"],
            "ratio": ratio,
            "status": pos["status"],
            "price_source": price_source,
            "message": pos["last_message"],
        })
        return pos["last_message"]

    @gl.public.write
    def resume_protocol(self) -> str:
        if str(gl.message.sender_address) != self.owner:
            raise Exception("ONLY_OWNER: only the deployer can resume the protocol")
        self.protocol_paused = False
        return "PROTOCOL_RESUMED: circuit breaker disengaged"

    @gl.public.write
    def set_threshold(self, new_threshold: int) -> str:
        if str(gl.message.sender_address) != self.owner:
            raise Exception("ONLY_OWNER: only the deployer can change the threshold")
        if new_threshold < 1 or new_threshold > 1000:
            raise Exception("INVALID_THRESHOLD: threshold must be between 1 and 1000")
        self.global_threshold = new_threshold
        return f"THRESHOLD_UPDATED: liquidation threshold is now {new_threshold}%"

    @gl.public.view
    def get_position_status(self, account_address: str) -> str:
        if account_address not in self.monitored_accounts:
            return "NOT_FOUND"
        return self.monitored_accounts[account_address]

    @gl.public.view
    def get_all_accounts(self) -> str:
        out = []
        for addr in self.monitored_accounts:
            record = json.loads(self.monitored_accounts[addr])
            record["address"] = addr
            out.append(record)
        return json.dumps(out)

    @gl.public.view
    def get_check_history(self, limit: int) -> str:
        out = []
        keys = []
        for k in self.check_history:
            keys.append(k)
        recent = keys[-limit:] if limit > 0 else keys
        for k in recent:
            out.append(json.loads(self.check_history[k]))
        return json.dumps(out)

    @gl.public.view
    def get_protocol_state(self) -> str:
        return json.dumps({
            "paused": self.protocol_paused,
            "threshold": str(self.global_threshold),
            "owner": self.owner,
            "total_checks": str(self.total_checks),
        })