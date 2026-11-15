// @fx/types may use db-client: it declares it and denies nothing. A pure workspace that
// allows @fx/types and denies db-client still must not reach it through this file.
import client from "db-client"

export const connectNow = (): string => client.connect()
