console.log("App.js loaded. Ethers:", typeof window.ethers);

if (!window.ethers) {
  alert("Ethers failed to load.");
  throw new Error("Ethers missing");
}
const ethers = window.ethers;

// =====================================================
// 0. OKX SAFETY WRAPPERS
// =====================================================

// 🔒 OKX hardening: detect OKX provider fallback
function getInjectedProvider() {
  return (
    window.ethereum ||
    window.okxwallet ||
    window.okxwallet?.ethereum ||
    null
  );
}

// 🔒 OKX hardening: safe-call wrapper for flaky RPC responses
async function safeCall(promise, fallback) {
  try {
    const v = await promise;
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

// =====================================================
// CONTRACT ADDRESSES
// =====================================================
const FACTORY_ADDRESS = "0x55cf712bd60ffd31bdbfec6831238bd726be48cc".toLowerCase();

const WPLS_ADDRESS = "0xa1077a294dde1b09bb078844df40758a5d0f9a27".toLowerCase();
const DAI_ADDRESS  = "0xefd766ccb38eaf1dfd701853bfce31359239f305".toLowerCase();
const PAIR_ADDRESS = "0xe56043671df55de5cdf8459710433c10324de0ae".toLowerCase();

// =====================================================
// ABIs
// =====================================================
const factoryAbi = [
  "event VaultCreated(address indexed owner, address vault, uint256 priceThreshold1e18, uint256 unlockTime)",
  "function createVault(uint256,uint256) external returns (address)"
];

const vaultAbi = [
  "function owner() view returns (address)",
  "function priceThreshold() view returns (uint256)",
  "function unlockTime() view returns (uint256)",
  "function withdrawn() view returns (bool)",
  "function currentPricePLSinDAI() view returns (uint256)",
  "function canWithdraw() view returns (bool)",
  "function withdraw() external"
];

const pairAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)"
];

// =====================================================
// STATE
// =====================================================
let walletProvider, signer, userAddress;
let factory, pairContract;
let locks = [];
let countdownInterval;
let pairToken0IsWPLS = true;

// =====================================================
// UI ELEMENTS
// =====================================================
const connectBtn          = document.getElementById("connectBtn");
const walletSpan          = document.getElementById("walletAddress");
const networkInfo         = document.getElementById("networkInfo");
const createForm          = document.getElementById("createForm");
const targetPriceInput    = document.getElementById("targetPrice");
const unlockDateTimeInput = document.getElementById("unlockDateTime");
const createStatus        = document.getElementById("createStatus");
const createBtn           = document.getElementById("createBtn");
const locksContainer      = document.getElementById("locksContainer");
const globalPriceDiv      = document.getElementById("globalPrice");
const globalPriceRawDiv   = document.getElementById("globalPriceRaw");
const manualVaultInput    = document.getElementById("manualVaultInput");
const addVaultBtn         = document.getElementById("addVaultBtn");
const manualAddStatus     = document.getElementById("manualAddStatus");

// =====================================================
// NETWORK PROMPT (ADDED)
const networkPrompt = document.getElementById("networkPrompt");

// =====================================================
// CONNECT WALLET
// =====================================================
async function connect() {
  try {
    // 🔒 OKX hardening: use safe injected provider
    const injected = getInjectedProvider();
    if (!injected) {
      alert("Wallet provider not found. Please reopen OKX or refresh.");
      return;
    }

    walletProvider = new ethers.providers.Web3Provider(injected, "any");
    await walletProvider.send("eth_requestAccounts", []);
    signer = walletProvider.getSigner();
    userAddress = (await signer.getAddress()).toLowerCase();

    const net = await walletProvider.getNetwork();
    walletSpan.textContent = userAddress;
    networkInfo.textContent = `Connected (chainId: ${net.chainId})`;

    factory      = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, signer);
    pairContract = new ethers.Contract(PAIR_ADDRESS, pairAbi, walletProvider);

    // Check the network immediately after connecting
    await checkNetwork(); // This checks if the user is connected to PulseChain

    await detectPairOrder();
    await refreshGlobalPrice();
    await loadLocalVaults();

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      if (locks.length) renderLocks();
    }, 1000);

  } catch (err) {
    alert("Connection failed: " + err.message);
    console.error(err);
  }
}
connectBtn.addEventListener("click", connect);
// =====================================================
// NETWORK CHECK AND SWITCHING (NEW)
async function checkNetwork() {
  const { chainId } = await walletProvider.getNetwork();  // Get current chainId
  
  // If not connected to PulseChain (chainId 369), show the prompt
  if (chainId !== 369) {
    networkPrompt.style.display = "block";  // Show the prompt
  } else {
    networkPrompt.style.display = "none";  // Hide the prompt if connected to PulseChain
  }
}


// =====================================================
// DETERMINE PAIR ORDER
async function detectPairOrder() {
  try {
    const token0 = (await safeCall(pairContract.token0(), WPLS_ADDRESS)).toLowerCase();
    pairToken0IsWPLS = (token0 === WPLS_ADDRESS);
  } catch {
    pairToken0IsWPLS = true;
  }
}

// =====================================================
// PRICE FEED
async function refreshGlobalPrice() {
  try {
    const [r0, r1] = await safeCall(pairContract.getReserves(), [ethers.constants.Zero, ethers.constants.Zero]);

    let wplsRes, daiRes;
    if (pairToken0IsWPLS) {
      wplsRes = r0;
      daiRes  = r1;
    } else {
      wplsRes = r1;
      daiRes  = r0;
    }

    if (!ethers.BigNumber.isBigNumber(wplsRes) || !ethers.BigNumber.isBigNumber(daiRes) || wplsRes.eq(0) || daiRes.eq(0)) {
      globalPriceDiv.textContent = "Price error.";
      return;
    }

    const price = daiRes.mul(ethers.constants.WeiPerEther).div(wplsRes);
    const float = Number(ethers.utils.formatUnits(price, 18));

    globalPriceDiv.textContent = `1 PLS ≈ ${float.toFixed(7)} DAI`;
    globalPriceRawDiv.textContent = `raw 1e18: ${price.toString()}`;

  } catch (err) {
    globalPriceDiv.textContent = "Price error.";
    console.error(err);
  }
}
setInterval(refreshGlobalPrice, 15000);

// =====================================================
// LOCAL STORAGE & VAULT MANAGEMENT
function localKey() { return "pls-vaults-" + userAddress; }

function getLocalVaults() {
  if (!userAddress) return [];
  const list = JSON.parse(localStorage.getItem(localKey()) || "[]");
  return list.map(v => ({ ...v, address: v.address.toLowerCase() }));
}

function saveLocalVault(vaultAddr, th, ut) {
  let list = getLocalVaults();
  const addr = vaultAddr.toLowerCase();
  if (!list.find(v => v.address === addr)) {
    list.push({ address: addr, threshold: th, unlockTime: ut });
    localStorage.setItem(localKey(), JSON.stringify(list));
  }
}

function removeVault(addr) {
  let list = getLocalVaults();
  list = list.filter(v => v.address !== addr.toLowerCase());
  localStorage.setItem(localKey(), JSON.stringify(list));
  loadLocalVaults();
}

// =====================================================
// MANUAL ADD VAULT
addVaultBtn.addEventListener("click", async () => {
  if (!userAddress) {
    manualAddStatus.textContent = "Connect wallet first.";
    return;
  }
  const addr = manualVaultInput.value.trim().toLowerCase();
  if (!ethers.utils.isAddress(addr)) {
    manualAddStatus.textContent = "Invalid address.";
    return;
  }
  saveLocalVault(addr, null, null);
  manualAddStatus.textContent = "Vault added.";
  manualVaultInput.value = "";
  await loadLocalVaults();
});

// =====================================================
// CREATE VAULT
createForm.addEventListener("submit", async e => {
  e.preventDefault();
  if (!signer) return alert("Connect wallet first.");

  try {
    createBtn.disabled = true;
    createStatus.textContent = "Sending...";

    const priceStr = targetPriceInput.value.trim();
    const th1e18 = ethers.utils.parseUnits(priceStr, 18);

    const dt = unlockDateTimeInput.value.trim();
    const ts = Date.parse(dt);
    if (isNaN(ts)) throw new Error("Invalid datetime");
    const unlockTime = Math.floor(ts / 1000);

    const tx = await factory.createVault(th1e18, unlockTime);
    const rcpt = await tx.wait();

    const iface = new ethers.utils.Interface(factoryAbi);
    let vaultAddr = null;

    for (const log of rcpt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p.name === "VaultCreated") {
          vaultAddr = p.args.vault;
          break;
        }
      } catch {}
    }

    if (!vaultAddr) {
      createStatus.textContent = "Vault created but address not parsed.";
      return;
    }

    vaultAddr = vaultAddr.toLowerCase();
    saveLocalVault(vaultAddr, th1e18.toString(), unlockTime);

    createStatus.textContent = "Vault created: " + vaultAddr;
    await loadLocalVaults();

  } catch (err) {
    createStatus.textContent = "Error: " + err.message;
    console.error(err);
  } finally {
    createBtn.disabled = false;
  }
});

// =====================================================
// LOAD LOCAL VAULTS
async function loadLocalVaults() {
  const list = getLocalVaults();
  if (!list.length) {
    locksContainer.textContent = "No locks found.";
    locks = [];
    return;
  }

  locks = list.map(v => ({
    address: v.address,
    threshold: v.threshold ? ethers.BigNumber.from(v.threshold) : null,
    unlockTime: v.unlockTime || null,
    balance: ethers.constants.Zero,
    currentPrice: ethers.constants.Zero,
    canWithdraw: false,
    withdrawn: false
  }));

  await Promise.all(locks.map(loadVaultDetails));
  renderLocks();
}

// =====================================================
// LOAD VAULT DETAILS
async function loadVaultDetails(lock) {
  try {
    const vault = new ethers.Contract(lock.address, vaultAbi, walletProvider);

    const withdrawn   = await safeCall(vault.withdrawn(), false);
    const currentPrice= await safeCall(vault.currentPricePLSinDAI(), ethers.constants.Zero);
    const canWithdraw = await safeCall(vault.canWithdraw(), false);
    const balance     = await safeCall(walletProvider.getBalance(lock.address), ethers.constants.Zero);
    const threshold   = await safeCall(vault.priceThreshold(), ethers.constants.Zero);
    const unlockTime  = await safeCall(vault.unlockTime(), ethers.constants.Zero);

    lock.withdrawn    = withdrawn;
    lock.currentPrice = currentPrice;
    lock.canWithdraw  = canWithdraw;
    lock.balance      = balance;
    lock.threshold    = threshold;
    lock.unlockTime   = unlockTime.toNumber ? unlockTime.toNumber() : 0;

  } catch (err) {
    console.error("Vault load error:", lock.address, err);
  }
}

// =====================================================
// RENDER LOCK CARDS
function renderLocks() {
  if (!locks.length) {
    locksContainer.textContent = "No locks found.";
    return;
  }

  locksContainer.innerHTML = locks.map(lock => {

    // 🔒 OKX safety: ensure BigNumbers before formatting
    const thresholdBN = (lock.threshold && ethers.BigNumber.isBigNumber(lock.threshold))
      ? lock.threshold
      : ethers.constants.Zero;

    const currentPriceBN = (lock.currentPrice && ethers.BigNumber.isBigNumber(lock.currentPrice))
      ? lock.currentPrice
      : ethers.constants.Zero;

    const target = parseFloat(ethers.utils.formatUnits(thresholdBN, 18));
    const currentPrecise = Number(ethers.utils.formatUnits(currentPriceBN, 18));
    const current = parseFloat(currentPrecise.toFixed(7));

    const bal = parseFloat(ethers.utils.formatUnits(
      (ethers.BigNumber.isBigNumber(lock.balance) ? lock.balance : ethers.constants.Zero),
      18
    ));

    const countdown = formatCountdown(lock.unlockTime);

    // -------------------------------
    // PRICE GOAL
    // -------------------------------
    let priceGoalPct = 0;

    if (ethers.BigNumber.isBigNumber(thresholdBN) &&
        ethers.BigNumber.isBigNumber(currentPriceBN) &&
        thresholdBN.gt(0)) {

      const pctBN = currentPriceBN.mul(10000).div(thresholdBN);
      priceGoalPct = pctBN.toNumber() / 100;
    }

    priceGoalPct = Math.max(0, Math.min(100, priceGoalPct));

    if (lock.canWithdraw && currentPriceBN.gte(thresholdBN)) {
      priceGoalPct = 100;
    }

    // -------------------------------
    // TIME PROGRESS
    // -------------------------------
    const nowTs = Math.floor(Date.now() / 1000);
    const progressPct = (timeProgress(nowTs, lock.unlockTime) * 100).toFixed(2);

    let status =
      lock.withdrawn
        ? '<span class="tag status-warn">WITHDRAWN</span>'
        : lock.canWithdraw
        ? '<span class="tag status-ok">UNLOCKABLE</span>'
        : '<span class="tag status-bad">LOCKED</span>';

    return `
      <div class="card vault-card ${lock.canWithdraw ? 'vault-unlockable' : ''}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;width:100%;max-width:500px;">
          <input class="mono"
            value="${lock.address}"
            readonly
            style="background:#ffffff;color:#000000;border:1px solid #ccd8e0;width:100%;padding:4px;border-radius:6px;" />
        
          <div class="copy-icon-btn" onclick="copyAddr('${lock.address}')">
            <svg viewBox="0 0 24 24">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 
                       0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 
                       2-.9 2-2V7c0-1.1-.9-2-2-2zm0 
                       16H8V7h11v14z"/>
            </svg>
          </div>
        </div>

        ${status}

        <div style="display:flex;flex-direction:row;align-items:flex-start;gap:16px;margin-top:10px;flex-wrap:nowrap;width:fit-content;max-width:100%;">
          <div style="display:flex;flex-direction:column;flex:0 1 auto;">
            <div><strong>Target:</strong> 1 PLS ≥ ${target.toFixed(6)} DAI</div>
            <div><strong>Current:</strong> ${current.toFixed(7)} DAI</div>
            <div><strong>Backup unlock:</strong> ${formatTimestamp(lock.unlockTime)}</div>
            <div><strong>Countdown:</strong> ${countdown}</div>
            <div style="margin-top:8px;"><strong>Locked:</strong> ${bal.toFixed(4)} PLS</div>
          </div>

          <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-start;flex:0 0 auto;min-width:70px;margin-left:8px;">
            <div class="small">Price goal</div>
            <div class="price-goal-pie"
                 style="background:conic-gradient(#00aa44 ${priceGoalPct}%, #ffffff 0);margin-top:4px;">
            </div>
            <div class="small">${priceGoalPct.toFixed(0)}%</div>
          </div>
        </div>

        <button onclick="withdrawVault('${lock.address}')"
          ${(!lock.canWithdraw || lock.withdrawn) ? "disabled" : ""}>
          Withdraw
        </button>

        <button onclick="removeVault('${lock.address}')"
          style="margin-left:10px;background:#b91c1c;">
          Remove
        </button>
      </div>
    `;
  }).join("");
}

// =====================================================
// WITHDRAW
async function withdrawVault(addr) {
  try {
    const vault = new ethers.Contract(addr, vaultAbi, signer);
    const tx = await safeCall(vault.withdraw(), null);
    if (tx) await tx.wait();
    await loadLocalVaults();
  } catch (err) {
    alert("Withdraw failed: " + err.message);
    console.error(err);
  }
}

// =====================================================
// COPY ADDRESS
function copyAddr(addr) {
  navigator.clipboard.writeText(addr).catch(err => {
    console.error("Copy failed:", err);
  });
}

// =====================================================
// TIME PROGRESS HELPER
// value from 0 → 1
function timeProgress(now, unlockTime, thresholdTime = 0) {
  if (now >= unlockTime) return 1;
  const total = unlockTime - thresholdTime;
  const done  = now - thresholdTime;
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, done / total));
}

// =====================================================
// UTILITIES
function formatTimestamp(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function formatCountdown(ts) {
  const now = Math.floor(Date.now() / 1000);
  let diff = ts - now;
  if (diff <= 0) return "0s";

  const d = Math.floor(diff / 86400);
  diff %= 86400;
  const h = Math.floor(diff / 3600);
  diff %= 3600;
  const m = Math.floor(diff / 60);
  const s = diff % 60;

  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

// -----------------------------------
// END OF FILE
