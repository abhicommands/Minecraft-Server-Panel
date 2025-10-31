export const API_URL = import.meta.env.VITE_API_URL ?? "";
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "";
export const SOCKET_PATH = import.meta.env.VITE_SOCKET_PATH ?? "";

export const ensureEnv = () => {
  if (!API_URL) {
    console.warn(
      "VITE_API_URL is not defined. API requests will fail until it is set."
    );
  }
  if (!SOCKET_URL) {
    console.warn(
      "VITE_SOCKET_URL is not defined. Socket connections will fail until it is set."
    );
  }
  if (!SOCKET_PATH) {
    console.warn(
      "VITE_SOCKET_PATH is not defined. Socket connections will fail until it is set."
    );
  }
};
