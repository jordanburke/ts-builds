import client from "db-client"

export const connect = (): string => client.connect()
