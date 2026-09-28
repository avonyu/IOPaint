import io from "socket.io-client"

export const SOCKET_ENDPOINT = import.meta.env.DEV
  ? import.meta.env.VITE_BACKEND
  : ""

export const socket = io(SOCKET_ENDPOINT)
