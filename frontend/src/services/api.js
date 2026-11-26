import axios, { AxiosError, AxiosHeaders } from "axios";
import {
  DemoServiceError,
  handleDemoRequest,
} from "../demo/demoService.js";

let accessToken = null;
const demoModeEnabled = __KRISTALLBALL_DEMO_MODE__ === true;
const networkAdapter = axios.getAdapter(axios.defaults.adapter);

async function localDemoAdapter(config) {
  try {
    const result = await handleDemoRequest(config);
    return {
      ...result,
      statusText: "OK",
      headers: new AxiosHeaders(),
      config,
      request: null,
    };
  } catch (error) {
    if (!(error instanceof DemoServiceError)) throw error;
    const response = {
      data: {
        success: false,
        error: { message: error.message },
      },
      status: error.status,
      statusText: error.status === 401 ? "Unauthorized" : "Demo request failed",
      headers: new AxiosHeaders(),
      config,
      request: null,
    };
    throw new AxiosError(
      error.message,
      AxiosError.ERR_BAD_REQUEST,
      config,
      null,
      response,
    );
  }
}

export function setAccessToken(token) {
  accessToken = typeof token === "string" && token.length > 0 ? token : null;
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 15000,
  adapter: demoModeEnabled ? localDemoAdapter : networkAdapter,
  headers: {
    "Content-Type": "application/json",
  },
});

api.interceptors.request.use(
  (config) => {
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      !error.config?.url?.endsWith("/auth/login")
    ) {
      window.dispatchEvent(new Event("kristallball:session-expired"));
    }

    return Promise.reject(error);
  },
);

export function apiErrorMessage(error) {
  if (error.response?.data?.error?.message) {
    return error.response.data.error.message;
  }
  if (!error.response) {
    return "The API could not be reached. Check the connection and try again.";
  }
  return "The request could not be completed. Try again.";
}

export function makeIdempotencyKey(operation) {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("A secure browser context is required for this operation.");
  }
  return `${operation}:${globalThis.crypto.randomUUID()}`;
}

export default api;
