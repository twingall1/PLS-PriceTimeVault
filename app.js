console.log("App.js loaded. Ethers:", typeof window.ethers);

if (!window.ethers) {
  alert("Ethers failed to load.");
  throw new Error("Ethers not loaded");
}
const ethers = window.ethers;

// ------------------------------
// CONTRACT ADDRESSES (lowercase)
// ------------------------------
const FACTORY_ADDRESS = "0x55cf712BD60Ffd31bDBfeC6831238Bd726BE48cC".toLowerCase(); 

const WPLS_ADDRESS = "0xa1077a294dde1b09bb078844df40758a5d0f9a27".toLowerCase();
const DAI_ADDRESS  = "0xefd766ccb38eaf1dfd701853bfce31359239f305".toLowerCase();
const PAIR_ADDRESS = "0xe56043671df55de5cdf8459710433c10324de0ae".toLowerCase();

// ------------------------------
// ABIs
// ------------------------------
const factoryAbi = [
  "event VaultCreated(address indexed owner, address vault, uint256 priceThreshold1e18, uint256 unlockTime)",
  "function createVault(uint256 priceThreshold1e18, uint256 unlockTime) external returns (address)"
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
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

// ------------------------------
// STATE
// ------------------------------
let walletProvider, signer, userAddress;
let factory, pairContract;
let locks = [];
let countdownInterval;
let pairToken0IsWPLS = true;

// ------------------------------
// UI ELEMENTS
// ------------------------------
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

// ------------------------------
// CONNECT WALLET
// ------------------------------
async function connect() {
  try {
    walletProvider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await walletProvider.send("eth_requestAccounts", []);
    signer = walletProvider.getSigner();
    userAddress = (await signer.getAddress()).toLowerCase();

    const network = await walletProvider.getNetwork();
    walletSpan.textContent = userAddress;
    networkInfo.textContent = `Connected (chainId: ${network.chainId})`;

    factory      = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, signer);
    pairContract = new ethers.Contract(PAIR_ADDRESS, pairAbi, walletProvider);

    await detectPairTokenOrdering();
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

// Determine liquidity pair ordering (token0 == WPLS?)
async function detectPairTokenOrdering() {
  try {
    const token0 = (await pairContract.token0()).toLowerCase();
    pairToken0IsWPLS = (token0 === WPLS_ADDRESS);
  } catch (err) {
    console.error("Pair read failed:", err);
    pairToken0IsWPLS = true;
  }
}

// ------------------------------
// GLOBAL PRICE FEED
// ------------------------------
async function refreshGlobalPrice() {
  try {
    const [r0, r1] = await pairContract.getReserves();

    let wplsRes, daiRes;
    if (pairToken0IsWPLS) {
      wplsRes = r0;
      daiRes  = r1;
    } else {
      wplsRes = r1;
      daiRes  = r0;
    }

    if (wplsRes.eq(0) || daiRes.eq(0)) {
      globalPriceDiv.textContent = "No liquidity.";
      return;
    }

    const price = daiRes.mul(ethers.constants.WeiPerEther).div(wplsRes);
    const float = parseFloat(ethers.utils.formatUnits(price, 18));

    globalPriceDiv.textContent = `1 PLS ≈ ${float.toFixed(6)} DAI`;
    globalPriceRawDiv.textContent = `raw 1e18: ${price.toString()}`;
  } catch (err) {
    globalPriceDiv.textContent = "Price error.";
    console.error(err);
  }
}

setInterval(refreshGlobalPrice, 15000);

// ------------------------------
// LOCAL STORAGE UTILS
// ------------------------------
function localKey() {
  return "pls-vaults-" + userAddress;
}

function getLocalVaults() {
  if (!userAddress) return [];
  const list = JSON.parse(localStorage.getItem(localKey()) || "[]");
  return list.map(v => ({ ...v, address: v.address.toLowerCase() }));
}

function saveLocalVault(vaultAddr, threshold, unlockTime) {
  let list = getLocalVaults();
  const addr = vaultAddr.toLowerCase();
  if (!list.find(v => v.address === addr)) {
    list.push({
      address: addr,
      threshold: threshold,
      unlockTime: unlockTime
    });
    localStorage.setItem(localKey(), JSON.stringify(list));
  }
}

// REMOVE vault entry from list
function removeVault(addr) {
  const key = localKey();
  let list = getLocalVaults();
  list = list.filter(v => v.address !== addr.toLowerCase());
  localStorage.setItem(key, JSON.stringify(list));
  loadLocalVaults();
}

// ------------------------------
// MANUAL ADD
// ------------------------------
addVaultBtn.addEventListener("click", async () => {
  if (!userAddress) {
    manualAddStatus.textContent = "Connect wallet first.";
    return;
  }

  const addr = manualVaultInput.value.trim().toLowerCase();
  if (!ethers.utils.isAddress(addr)) {
    manualAddStatus.textContent = "Invalid vault address.";
    return;
  }

  saveLocalVault(addr, null, null);
  manualAddStatus.textContent = "Vault added.";
  manualVaultInput.value = "";
  await loadLocalVaults();
});

// ------------------------------
// CREATE VAULT
// ------------------------------
createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!signer) {
    alert("Connect wallet first.");
    return;
  }

  try {
    createBtn.disabled = true;
    createStatus.textContent = "Sending...";

    const priceStr = targetPriceInput.value.trim();
    const threshold1e18 = ethers.utils.parseUnits(priceStr, 18);

    const dtISO = unlockDateTimeInput.value.trim();
    const ts = Date.parse(dtISO);
    if (isNaN(ts)) throw new Error("Invalid datetime");
    const unlockTime = Math.floor(ts / 1000);

    const tx = await factory.createVault(threshold1e18, unlockTime);
    const receipt = await tx.wait();

    const iface = new ethers.utils.Interface(factoryAbi);
    let vaultAddr = null;

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === "VaultCreated") {
          vaultAddr = parsed.args.vault;
          break;
        }
      } catch (_) {}
    }

    if (!vaultAddr) {
      createStatus.textContent = "Vault created but log not parsed.";
      return;
    }

    vaultAddr = vaultAddr.toLowerCase();
    saveLocalVault(vaultAddr, threshold1e18.toString(), unlockTime);
    createStatus.textContent = "Vault created: " + vaultAddr;

    await loadLocalVaults();
  } catch (err) {
    createStatus.textContent = "Error: " + err.message;
    console.error(err);
  } finally {
    createBtn.disabled = false;
  }
});

// ------------------------------
// LOAD LOCAL VAULTS
// ------------------------------
async function loadLocalVaults() {
  locks = [];
  const list = getLocalVaults();

  if (!list.length) {
    locksContainer.textContent = "No locks found.";
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

// ------------------------------
// LOAD VAULT DETAILS
// ------------------------------
async function loadVaultDetails(lock) {
  try {
    const vault = new ethers.Contract(lock.address, vaultAbi, walletProvider);

    const [
      withdrawn,
      currentPrice,
      canWithdraw,
      balance,
      thresholdOnChain,
      unlockTimeOnChain
    ] = await Promise.all([
      vault.withdrawn(),
      vault.currentPricePLSinDAI(),
      vault.canWithdraw(),
      walletProvider.getBalance(lock.address),
      vault.priceThreshold(),
      vault.unlockTime()
    ]);

    lock.withdrawn   = withdrawn;
    lock.currentPrice = currentPrice;
    lock.canWithdraw  = canWithdraw;
    lock.balance      = balance;
    lock.threshold    = thresholdOnChain;
    lock.unlockTime   = unlockTimeOnChain.toNumber();

  } catch (err) {
    console.error("Vault load error:", lock.address, err);
  }
}

// ------------------------------
// RENDER VAULT CARDS
// ------------------------------
function renderLocks() {
  if (!locks.length) {
    locksContainer.textContent = "No locks found.";
    return;
  }

  locksContainer.innerHTML = locks.map(lock => {
    const target = lock.threshold
      ? parseFloat(ethers.utils.formatUnits(lock.threshold, 18))
      : 0;

    const current = parseFloat(ethers.utils.formatUnits(lock.currentPrice, 18));
    const bal = parseFloat(ethers.utils.formatUnits(lock.balance, 18));
    const countdown = formatCountdown(lock.unlockTime);

    let status =
      lock.withdrawn
        ? '<span class="tag status-warn">WITHDRAWN</span>'
        : lock.canWithdraw
        ? '<span class="tag status-ok">UNLOCKABLE</span>'
        : '<span class="tag status-bad">LOCKED</span>';

    return `
      <div class="card vault-card ${lock.canWithdraw ? 'vault-unlockable' : ''}">
        <input class="mono" 
               value="${lock.address}" 
               readonly
               style="background:#3a1500;border:1px solid #ffb84d;width:100%;padding:4px;border-radius:6px;"/>

        ${status}
        <div><strong>Target:</strong> 1 PLS ≥ ${target.toFixed(6)} DAI</div>
        <div><strong>Current:</strong> ${current.toFixed(6)} DAI</div>
        <div><strong>Backup unlock:</strong> ${formatTimestamp(lock.unlockTime)}</div>
        <div><strong>Countdown:</strong> ${countdown}</div>
        <div style="margin-top:8px;">
          <div class="small">Time Progress</div>
          <div style="background:#3a1500;width:100%;height:10px;border-radius:5px;overflow:hidden;border:1px solid #ffb84d;">
            <div style="
              width:${(timeProgress(Math.floor(Date.now()/1000), lock.unlockTime) * 100).toFixed(2)}%;
              height:100%;
              background:#ff8800;
              transition: width 1s linear;
            "></div>
          </div>
        </div>
        <div><strong>Locked:</strong> ${bal.toFixed(4)} PLS</div>

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

// ------------------------------
// WITHDRAW
// ------------------------------
async function withdrawVault(addr) {
  try {
    const vault = new ethers.Contract(addr, vaultAbi, signer);
    const tx = await vault.withdraw();
    await tx.wait();
    await loadLocalVaults();
  } catch (err) {
    alert("Withdraw failed: " + err.message);
    console.error(err);
  }
}

// ------------------------------
// UTILITIES
// ------------------------------
function formatTimestamp(ts) {
  return new Date(ts * 1000).toLocaleString();
}
function timeProgress(now, unlockTime, thresholdTime = 0) {
  if (now >= unlockTime) return 1;
  const total = unlockTime - thresholdTime;
  const done = now - thresholdTime;
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, done / total));
}
function formatCountdown(ts) {
  const now = Math.floor(Date.now() / 1000);
  let diff = ts - now;
  if (diff <= 0) return "0s";

  const d = Math.floor(diff / 86400); diff %= 86400;
  const h = Math.floor(diff / 3600);  diff %= 3600;
  const m = Math.floor(diff / 60);
  const s = diff % 60;

  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}
