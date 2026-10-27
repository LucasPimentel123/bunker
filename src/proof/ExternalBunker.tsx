import { App } from "../App";
import "../style.css";
import "../recovery.css";
export default function ExternalBunker({ leave }: { leave: () => void }) { return <App local onLeave={leave}/>; }
