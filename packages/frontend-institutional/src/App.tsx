import { useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./index.css";

import GeoGate from "./components/GeoGate";
import Layout, { Tab } from "./components/Layout";
import KycGate from "./components/KycGate";
import PositionsPage from "./pages/PositionsPage";
import PreparePage from "./pages/PreparePage";
import CreditTradePage from "./pages/CreditTradePage";
import FixedYieldPage from "./pages/FixedYieldPage";
import { WalletBalancesProvider } from "./hooks/useWalletBalances";

const RPC = "https://api.devnet.solana.com";

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  // Default landing is the renamed Overview tab — same code path as the
  // old "prepare" route, just with the lending-flow narrative folded in
  // at the top so it doubles as the entry-point dashboard.
  const [tab, setTab] = useState<Tab>("prepare");

  return (
    <GeoGate>
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletBalancesProvider>
            <Layout tab={tab} setTab={setTab}>
              <KycGate>
                {tab === "prepare" && <PreparePage />}
                {tab === "positions" && <PositionsPage />}
                {tab === "credit_trade" && <CreditTradePage />}
                {tab === "fixed_yield" && <FixedYieldPage />}
              </KycGate>
            </Layout>
          </WalletBalancesProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
    </GeoGate>
  );
}
