import { EmulatorTokenProvider } from "../../src/lib/googleAuth";
import { lookupUserByEmail, setCustomClaims } from "../../src/lib/identityToolkit";
import { AUTH_EMULATOR_HOST, TEST_PROJECT_ID, uniqueId } from "../helpers";

const adminOptions = {
  apiKey: "demo-api-key",
  emulatorHost: AUTH_EMULATOR_HOST,
  projectId: TEST_PROJECT_ID,
  tokenProvider: new EmulatorTokenProvider(),
};

/** Creates an account in the Auth emulator; optionally makes it an admin. */
export async function createUser(options: { admin: boolean }): Promise<{
  uid: string;
  email: string;
  password: string;
}> {
  const email = `${uniqueId("user")}@example.com`.toLowerCase();
  const password = `pw-${uniqueId("x")}`;
  const response = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`Auth emulator signUp failed: ${response.status.toString()}`);
  const { localId } = await response.json<{ localId: string }>();
  if (options.admin) await setCustomClaims(adminOptions, localId, { admin: true });
  return { uid: localId, email, password };
}

export { adminOptions, lookupUserByEmail };
