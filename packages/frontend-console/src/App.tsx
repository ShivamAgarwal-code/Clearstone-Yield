import { useMemo } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

import GeoGate from "./components/GeoGate";
import Layout from "./components/Layout";
import { AuthorityProvider } from "./hooks/useAuthority";

const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter({ network })], []);

  return (
    <GeoGate>
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AuthorityProvider>
            <Layout />
          </AuthorityProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
    </GeoGate>
  );
}
