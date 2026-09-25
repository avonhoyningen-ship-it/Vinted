import { vintedClient } from "../../src/vinted/vintedClient.js";
import { mockAdapter } from "./mockAdapter.js";

// The app itself only talks to the real Vinted client; tests swap in a fake.
vintedClient.useAdapter(mockAdapter, 0);
