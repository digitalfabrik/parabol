import {GraphQLNonNull} from 'graphql'
import {SubscriptionChannel} from 'parabol-client/types/constEnums'
import makeAgendaItemSchema from 'parabol-client/validation/makeAgendaItemSchema'
import {positionAfter} from '../../../client/shared/sortOrder'
import getRethink from '../../database/rethinkDriver'
import AgendaItem, {AgendaItemInput} from '../../database/types/AgendaItem'
import generateUID from '../../generateUID'
import getKysely from '../../postgres/getKysely'
import {analytics} from '../../utils/analytics/analytics'
import {getUserId, isTeamMember} from '../../utils/authorization'
import publish from '../../utils/publish'
import standardError from '../../utils/standardError'
import AddAgendaItemPayload from '../types/AddAgendaItemPayload'
import CreateAgendaItemInput, {CreateAgendaItemInputType} from '../types/CreateAgendaItemInput'
import {GQLContext} from './../graphql'
import addAgendaItemToActiveActionMeeting from './helpers/addAgendaItemToActiveActionMeeting'

export default {
  type: AddAgendaItemPayload,
  description: 'Create a new agenda item',
  args: {
    newAgendaItem: {
      type: new GraphQLNonNull(CreateAgendaItemInput),
      description: 'The new task including an id, teamMemberId, and content'
    }
  },
  async resolve(
    _source: unknown,
    {newAgendaItem}: {newAgendaItem: CreateAgendaItemInputType},
    {authToken, dataLoader, socketId: mutatorId}: GQLContext
  ) {
    const r = await getRethink()
    const operationId = dataLoader.share()
    const subOptions = {mutatorId, operationId}
    const viewerId = getUserId(authToken)
    // AUTH
    const {teamId} = newAgendaItem
    if (!isTeamMember(authToken, teamId)) {
      return standardError(new Error('Team not found'), {userId: viewerId})
    }
    const viewer = await dataLoader.get('users').loadNonNull(viewerId)
    // VALIDATION
    const schema = makeAgendaItemSchema()
    const {errors, data: validNewAgendaItem} = schema(newAgendaItem)
    if (Object.keys(errors).length) {
      return standardError(new Error('Failed input validation'), {userId: viewerId})
    }

    // RESOLUTION
    const teamAgendaItems = await dataLoader.get('agendaItemsByTeamId').load(teamId)
    const lastAgendaItem = teamAgendaItems.at(-1)
    const lastSortOrder = lastAgendaItem?.sortOrder ? String(lastAgendaItem.sortOrder) : ''
    // this is just during the migration of AgendaItem table
    const sortOrder = positionAfter(lastSortOrder)
    const agendaItemId = `${teamId}::${generateUID()}`
    await r
      .table('AgendaItem')
      .insert(
        new AgendaItem({
          ...validNewAgendaItem,
          teamId
        } as AgendaItemInput)
      )
      .run()
    await getKysely()
      .insertInto('AgendaItem')
      .values({
        id: agendaItemId,
        content: newAgendaItem.content,
        meetingId: newAgendaItem.meetingId,
        pinned: newAgendaItem.pinned,
        sortOrder,
        teamId,
        teamMemberId: newAgendaItem.teamMemberId
      })
      .execute()
    const meetingId = await addAgendaItemToActiveActionMeeting(agendaItemId, teamId, dataLoader)
    analytics.addedAgendaItem(viewer, teamId, meetingId)
    const data = {agendaItemId, meetingId}
    publish(SubscriptionChannel.TEAM, teamId, 'AddAgendaItemPayload', data, subOptions)
    return data
  }
}
