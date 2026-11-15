// Reaches db-client, which @fx/rules denies: depcruise reports it from src/reaches-denied-own.ts.
import client from "db-client"

export const load = (): string => client.connect()
