/**
 * Compute walletRef (bytes32) from P256 public key.
 * walletRef = bytes32(uint256(uint160(safeAddress)))
 * where safeAddress is the deterministic Safe proxy address derived from the P256 key.
 */
import {
  encodeAbiParameters,
  encodePacked,
  parseAbiParameters,
  keccak256,
  concat,
  pad,
  getAddress,
  type Address,
  type Hex,
} from "viem";

const SAFE_PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_4337_MODULE = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";
const SAFE_MODULE_SETUP = "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47";
const WEBAUTHN_SIGNER = "0x94a4F6affBd8975951142c3999aEAB7ecee555c2";
const MULTI_SEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";
const PROXY_CREATION_CODE = "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564" as Hex;

function fnSelector(sig: string): Hex {
  return keccak256(encodePacked(["string"], [sig])).slice(0, 10) as Hex;
}

function encodeMultiSendTx(to: string, data: Hex, operation: number): Hex {
  const opByte = ("0x" + operation.toString(16).padStart(2, "0")) as Hex;
  const toBytes = to.toLowerCase().slice(2).padStart(40, "0");
  const value = "0".repeat(64);
  const dataBytes = data.slice(2);
  const dataLen = (dataBytes.length / 2).toString(16).padStart(64, "0");
  return ("0x" + opByte.slice(2) + toBytes + value + dataLen + dataBytes) as Hex;
}

/** Compute deterministic Safe wallet address from uncompressed P256 public key. */
function computeSafeAddress(publicKeyHex: string): Address {
  let clean = publicKeyHex.startsWith("0x") ? publicKeyHex.slice(2) : publicKeyHex;
  if (clean.startsWith("04")) clean = clean.slice(2);
  const x = ("0x" + clean.slice(0, 64)) as Hex;
  const y = ("0x" + clean.slice(64)) as Hex;

  const saltNonce = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [x, y]));

  const enableModulesData = concat([
    fnSelector("enableModules(address[])"),
    encodeAbiParameters(parseAbiParameters("uint256"), [32n]),
    encodeAbiParameters(parseAbiParameters("uint256"), [1n]),
    encodeAbiParameters(parseAbiParameters("address"), [SAFE_4337_MODULE]),
  ]);

  const configureData = concat([
    fnSelector("configure((uint256,uint256,uint176))"),
    pad(x, { size: 32 }),
    pad(y, { size: 32 }),
    encodeAbiParameters(parseAbiParameters("uint256"), [0x100n]),
  ]);

  const tx1 = encodeMultiSendTx(SAFE_MODULE_SETUP, enableModulesData, 1);
  const tx2 = encodeMultiSendTx(WEBAUTHN_SIGNER, configureData, 1);
  const packed = concat([tx1, tx2]);
  const packedLen = (packed.length - 2) / 2;
  const paddingLen = (32 - (packedLen % 32)) % 32;

  const multiSendData = concat([
    fnSelector("multiSend(bytes)"),
    encodeAbiParameters(parseAbiParameters("uint256"), [32n]),
    encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(packedLen)]),
    packed,
    ("0x" + "00".repeat(paddingLen)) as Hex,
  ]);

  const multiSendDataLen = (multiSendData.length - 2) / 2;
  const dataPaddingLen = (32 - (multiSendDataLen % 32)) % 32;

  const setupData = concat([
    fnSelector("setup(address[],uint256,address,bytes,address,address,uint256,address)"),
    encodeAbiParameters(parseAbiParameters("uint256"), [256n]),
    encodeAbiParameters(parseAbiParameters("uint256"), [1n]),
    encodeAbiParameters(parseAbiParameters("address"), [MULTI_SEND]),
    encodeAbiParameters(parseAbiParameters("uint256"), [256n + 64n]),
    encodeAbiParameters(parseAbiParameters("address"), [SAFE_4337_MODULE]),
    encodeAbiParameters(parseAbiParameters("address"), ["0x0000000000000000000000000000000000000000"]),
    encodeAbiParameters(parseAbiParameters("uint256"), [0n]),
    encodeAbiParameters(parseAbiParameters("address"), ["0x0000000000000000000000000000000000000000"]),
    encodeAbiParameters(parseAbiParameters("uint256"), [1n]),
    encodeAbiParameters(parseAbiParameters("address"), [WEBAUTHN_SIGNER]),
    encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(multiSendDataLen)]),
    multiSendData,
    ("0x" + "00".repeat(dataPaddingLen)) as Hex,
  ]);

  const deploymentCode = concat([PROXY_CREATION_CODE, encodeAbiParameters(parseAbiParameters("address"), [SAFE_SINGLETON])]);
  const initCodeHash = keccak256(deploymentCode);
  const initializerHash = keccak256(setupData);
  const salt = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [initializerHash, saltNonce]));

  const addressHash = keccak256(concat(["0xff" as Hex, SAFE_PROXY_FACTORY as Hex, salt, initCodeHash]));
  return getAddress("0x" + addressHash.slice(26));
}

/** Compute walletRef from P256 public key: Safe address → bytes32(uint256(uint160(address))) */
export function buildWalletRef(publicKeyHex: string): Hex {
  const address = computeSafeAddress(publicKeyHex);
  return pad(address.toLowerCase() as Hex, { size: 32, dir: "left" });
}
