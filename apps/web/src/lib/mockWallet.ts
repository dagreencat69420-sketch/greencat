/**
 * Read-only mock wallet for local UI testing and screenshots ONLY.
 * Enabled when the app is built with NEXT_PUBLIC_MOCK_WALLET=<pubkey> on a non-mainnet cluster.
 * It can't sign anything: every signing request fails with a "User rejected" error, which also
 * exercises the rejected-signature UI.
 */
import {
  BaseMessageSignerWalletAdapter,
  WalletName,
  WalletNotConnectedError,
  WalletReadyState,
  WalletSignTransactionError,
  type SupportedTransactionVersions,
} from "@solana/wallet-adapter-base";
import { PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { CLUSTER } from "@/lib/config";

export const MOCK_WALLET_NAME = "Mock Wallet (read-only)" as WalletName<"Mock Wallet (read-only)">;

export function mockWalletKey(): PublicKey | null {
  const k = process.env.NEXT_PUBLIC_MOCK_WALLET?.trim();
  if (!k || CLUSTER === "mainnet-beta") return null;
  try {
    return new PublicKey(k);
  } catch {
    return null;
  }
}

export class MockWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = MOCK_WALLET_NAME;
  url = "https://github.com/dagreencat69420-sketch/greencat-app";
  icon =
    "data:image/svg+xml;base64," +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#b8ff3c"/></svg>');
  readyState = WalletReadyState.Installed;
  supportedTransactionVersions: SupportedTransactionVersions = new Set(["legacy", 0] as const);
  connecting = false;
  private _pk: PublicKey | null = null;

  constructor(private key: PublicKey) {
    super();
  }
  get publicKey() {
    return this._pk;
  }
  async connect() {
    this._pk = this.key;
    this.emit("connect", this.key);
  }
  async disconnect() {
    this._pk = null;
    this.emit("disconnect");
  }
  private reject(): never {
    if (!this._pk) throw new WalletNotConnectedError();
    throw new WalletSignTransactionError("User rejected the request (mock wallet is read-only).");
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> {
    return this.reject();
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> {
    return this.reject();
  }
  async signMessage(_m: Uint8Array): Promise<Uint8Array> {
    return this.reject();
  }
}
