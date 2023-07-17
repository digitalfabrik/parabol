import {sql} from 'kysely'
import toTeamMemberId from 'parabol-client/utils/relay/toTeamMemberId'
import getRethink from '../../../database/rethinkDriver'
import {RValue} from '../../../database/stricterR'
import AuthToken from '../../../database/types/AuthToken'
import getKysely from '../../../postgres/getKysely'
import {getUserId} from '../../../utils/authorization'
import sendToSentry from '../../../utils/sendToSentry'
import standardError from '../../../utils/standardError'

const safelyCastVote = async (
  authToken: AuthToken,
  meetingId: string,
  userId: string,
  reflectionGroupId: string,
  maxVotesPerGroup: number
) => {
  const meetingMemberId = toTeamMemberId(meetingId, userId)
  const r = await getRethink()
  const pg = getKysely()
  const now = new Date()
  const viewerId = getUserId(authToken)
  const isVoteRemovedFromUser = await r
    .table('MeetingMember')
    .get(meetingMemberId)
    .update((member: RValue) => {
      // go atomic. no cheating allowed
      return r.branch(
        member('votesRemaining').ge(1),
        {
          updatedAt: now,
          votesRemaining: member('votesRemaining').sub(1)
        },
        {}
      )
    })('replaced')
    .eq(1)
    .run()
  if (!isVoteRemovedFromUser) {
    return standardError(new Error('No votes remaining'), {userId: viewerId})
  }

  const [isVoteAddedToGroup, voteAddedResult] = await Promise.all([
    r
      .table('RetroReflectionGroup')
      .get(reflectionGroupId)
      .update((group: RValue) => {
        return r.branch(
          group('voterIds').count(userId).lt(maxVotesPerGroup),
          {
            updatedAt: now,
            voterIds: group('voterIds').append(userId)
          },
          {}
        )
      })('replaced')
      .eq(1)
      .run(),
    pg
      .updateTable('RetroReflectionGroup')
      .set({voterIds: sql`ARRAY_APPEND("voterIds",${userId})`})
      .where('id', '=', reflectionGroupId)
      .where(
        sql`COALESCE(array_length(array_positions("voterIds", ${userId}),1),0)`,
        '<',
        maxVotesPerGroup
      )
      .executeTakeFirst()
  ])
  const isVoteAddedToGroupPG = voteAddedResult.numUpdatedRows === BigInt(1)
  if (isVoteAddedToGroupPG !== isVoteAddedToGroup)
    sendToSentry(new Error('MISMATCH VOTE CAST LOGIC'))
  if (!isVoteAddedToGroup) {
    await r
      .table('MeetingMember')
      .get(meetingMemberId)
      .update((member: RValue) => ({
        votesRemaining: member('votesRemaining').add(1)
      }))
      .run()
    return standardError(new Error('Max votes per group exceeded'), {userId: viewerId})
  }
  return undefined
}

export default safelyCastVote
