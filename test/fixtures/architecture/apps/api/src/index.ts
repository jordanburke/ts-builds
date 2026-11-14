import { connect } from "@fx/db"
import { id } from "@fx/rules"
import { data } from "@fx/shared/data"

export const handler = [connect, id, data]
