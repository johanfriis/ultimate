import { describe, expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  AgentDoc,
  defineExtension,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
} from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Messages } from '../extensions/messages/api.ts'
import { branchOf, rootOf } from '../extensions/lineage/server.ts'
import { Branch } from '../extensions/lineage/api.ts'
import { Index, Side, tracksEffect } from '../extensions/side-chat/server.ts'
import { fauxServer, post, until } from './helpers.ts'
import { entries, fixture, servers, ultimateRoot } from './side-chat-fixture.ts'

describe('side chats', () => {
  it('forks the last completed run while main is busy, preserves the entire prompt including codemode and all tools, and stays outside lineage', async () => {
    const f = await fixture()
    const mainBefore = f.requests.at(-1)!
    const finished = (await entries(f.server, f.main)).at(-1)!.id
    let entered = false
    const messages = f.server.host.registry.snapshot().extension('messages')!
    f.server.host.registry.install(
      defineExtension({
        ...messages,
        hooks: [
          ...(messages.hooks ?? []),
          hook(ToolTask, {
            beforeTool: async (call) => {
              if (call.name === 'message') {
                entered = true
                await f.hold.promise
              }
              return undefined
            },
          }),
        ],
      }),
    )
    const running = await (await f.server.harness.conversation(f.main, context))!.submit(
      {
        type: 'input',
        content: `CALL ${JSON.stringify({ name: 'message', args: { to: 'user', text: 'holding main' } })}`,
      },
      context,
    )
    await until(() => entered)
    const unfinished = (await entries(f.server, f.main)).at(-1)!
    expect(unfinished.kind).toBe('pi.assistant')
    expect(unfinished.model?.[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'toolCall', name: 'message' })]),
    )
    const side = await f.open()
    const doc = await f.server.harness.snapshot(Side, side, context)
    expect(doc).toEqual({ of: f.main, at: finished, effects: false })
    const fork = (await f.server.harness.conversation(side, context))!
    const sideEntries = await entries(f.server, side)
    expect(sideEntries.some((entry) => entry.id === unfinished.id)).toBe(false)
    const own = sideEntries.filter((entry) => entry.conversationId === side)
    const reminder = own.findIndex(
      (entry) =>
        entry.kind === 'conversations.identity' &&
        JSON.stringify(entry.model).includes(`You are in a side chat (#${side})`),
    )
    expect(reminder).toBeGreaterThanOrEqual(0)
    // The reminder is read before the user's first words.
    expect(own.findIndex((entry) => entry.kind === 'pi.user')).toBeGreaterThan(reminder)
    expect(f.requests.at(-1)!.system).toBe(mainBefore.system)
    expect(mainBefore.system).toContain('codemode')
    expect(await f.server.harness.snapshot(AgentDoc, side, context)).toEqual(
      await f.server.harness.snapshot(AgentDoc, f.main, context),
    )
    expect((await fork.agent(context)).tools.map((tool) => tool.name)).toEqual(
      (await (await f.server.harness.conversation(f.main, context))!.agent(context)).tools.map(
        (tool) => tool.name,
      ),
    )
    expect((await f.server.harness.snapshot(AgentDoc, side, context))!.tools).toContain('compact')
    const host = { harness: () => f.server.harness }
    expect(await branchOf(host, side, context)).toBeUndefined()
    expect(await rootOf(host, side, context)).toBeUndefined()
    expect((await f.server.harness.snapshot(Branch, side, context))?.branch).toBeUndefined()
    await until(
      () =>
        f.server.api.conversations().find((conversation) => conversation.id === side)?.label ===
        'side-chat',
    )
    const listed = f.server.api.conversations().find((conversation) => conversation.id === side)!
    expect(listed.label).toBe('side-chat')
    expect(listed.branchOf).toEqual({ conversationId: f.main, at: finished })
    const index = await f.server.harness.snapshot(Index, f.main, context)
    expect(index!.sides).toEqual([{ id: side, at: finished, openedAt: expect.any(Number) }])
    expect((await f.action('open', { text: 'nested' }, side)).data.error).toMatch(
      /cannot open another/,
    )
    expect((await f.action('open', { text: 'wrong' }, ROOT_CONVERSATION_ID)).data.error).toMatch(
      /Only @ultimate/,
    )
    const second = await f.open('ANOTHER')
    expect(second).not.toBe(side)
    f.hold.resolve()
    await running.wait(context)
  })

  it('schedules no automatic summary task for a side chat, so its title stays Side chat', async () => {
    const f = await fixture()
    const side = await f.open()
    await f.ask(side, 'A question answered in the side chat.')
    const tasks = await f.server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: side, kind: 'conversations.summary' }, 100),
      context,
    )
    expect(tasks.items).toEqual([])
    // No intent or reply summary entry: only the hidden identity reminders are the conversations extension's.
    expect(
      (await entries(f.server, side)).filter(
        (entry) =>
          entry.conversationId === side &&
          entry.kind.startsWith('conversations.') &&
          entry.kind !== 'conversations.identity',
      ),
    ).toEqual([])
    expect(
      f.server.api.conversations().find((conversation) => conversation.id === side),
    ).toMatchObject({ title: 'Side chat' })
  })

  it('includes terminal tool results and ignores completed generations inside an unfinished run', async () => {
    const f = await fixture()
    await f.call(f.main, 'message', { to: 'user', text: 'finished tool-terminated turn' })
    const closing = (await entries(f.server, f.main)).at(-1)!
    expect(closing.model?.[0].role).toBe('toolResult')
    const first = await f.open()
    expect((await f.server.harness.snapshot(Side, first, context))!.at).toBe(closing.id)
    f.gate.afterTool = true
    const running = f.call(f.main, 'note', { to: ROOT_CONVERSATION_ID, text: 'still working' })
    await until(() => f.gate.entered)
    // This tool round's generation is completed, but no input submission is answered yet.
    const side = await f.open()
    expect((await f.server.harness.snapshot(Side, side, context))!.at).toBe(closing.id)
    f.hold.resolve()
    await running
  })

  it('refuses side-chat lifecycle actions invoked by an agent', async () => {
    const f = await fixture()
    await f.call(f.main, 'codemode', {
      code: "return await ultimate.action('side-chat', 'open', {text: 'agent must not open'})",
    })
    expect(JSON.stringify(await entries(f.server, f.main))).toContain(
      'side-chat/open is a user-only action',
    )
    expect((await f.server.harness.snapshot(Index, f.main, context))?.sides ?? []).toEqual([])
  })

  it('tracks only the specified tool/actions before execution, including failures, and persists effects across reopen', async () => {
    for (const name of [
      'branch',
      'message',
      'note',
      'notify',
      'remember',
      'setup',
      'restart',
      'edit',
      'write',
    ])
      expect(tracksEffect(name, {})).toBe(true)
    for (const name of ['bash', 'codemode', 'read', 'memory'])
      expect(tracksEffect(name, {})).toBe(false)
    for (const action of ['add', 'done']) expect(tracksEffect('todo', { action })).toBe(true)
    expect(tracksEffect('todo', { action: 'list' })).toBe(false)
    for (const action of ['list', 'runs', 'log'])
      expect(tracksEffect('automation', { action })).toBe(false)
    for (const action of [
      'create',
      'subscribe',
      'unsubscribe',
      'update',
      'pause',
      'resume',
      'run',
      'abort',
      'delete',
      'escalate',
    ])
      expect(tracksEffect('automation', { action })).toBe(true)
    const f = await fixture()
    const side = await f.open()
    await f.call(side, 'todo', { action: 'list' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(false)
    // A side chat keeps @ultimate's to-dos as main.
    await f.call(side, 'todo', { action: 'add', text: 'from the side', owner: 'user' })
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Added 1 for user: from the side',
    )
    await f.call(side, 'message', { to: 'user', text: 'must fail' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Only @ultimate messages the user',
    )
    expect((await f.action('discard', { id: side })).data.error).toMatch(/has effects/)
    servers.splice(servers.indexOf(f.server), 1)
    await f.server.close()
    const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
    servers.push(reopened)
    expect((await reopened.harness.snapshot(Side, side, context))!.effects).toBe(true)
    const refused = await post(reopened, '/api/extensions/side-chat/actions/discard', {
      args: { id: side },
      conversationId: f.main,
    })
    expect(refused.data.error).toMatch(/has effects/)
  })

  it('attributes messages and notes to main, returns replies there, refuses messaging self/user, and leaves one provenance note', async () => {
    const f = await fixture()
    const target = await f.server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: (await f.server.root.agent(context)).model },
      },
      context,
    )
    const side = await f.open()
    await f.call(side, 'note', { to: target.id, text: 'a note' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    const note = (await entries(f.server, target.id)).find(
      (entry) => entry.kind === 'lineage.note',
    )!
    expect(note.data).toMatchObject({ from: f.main, text: 'a note' })
    await f.call(side, 'message', { to: `#${target.id}`, text: 'one question', reply: true })
    await until(async () => {
      const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
      return board.messages.some((message) => message.from === target.id && message.to === f.main)
    })
    const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
    expect(board.messages.find((message) => message.text === 'one question')).toMatchObject({
      from: f.main,
      to: target.id,
      reply: true,
    })
    expect(board.messages.filter((message) => message.to === side)).toEqual([])
    const provenance = (await entries(f.server, f.main)).filter(
      (entry) =>
        entry.kind === 'lineage.note' &&
        JSON.stringify(entry.data).includes(`Side chat #${side} messaged`),
    )
    expect(provenance).toHaveLength(1)
    await f.call(side, 'message', { to: '@ultimate', text: 'self' })
    expect(JSON.stringify(await entries(f.server, side))).toContain('You cannot message yourself')
    await f.call(side, 'message', { to: 'user', text: 'user' })
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Only @ultimate messages the user',
    )
  })

  it.each([
    ['message', 'latest'],
    ['message', 'entry'],
    ['branch', 'latest'],
    ['branch', 'entry'],
  ] as const)(
    'forwards the side chat image for %s with %s, not main’s image',
    async (tool, ref) => {
      const f = await fixture()
      const side = await f.open()
      const image = {
        type: 'image' as const,
        data: Buffer.from('side').toString('base64'),
        mimeType: 'image/png',
      }
      const appendImage = (id: ConversationId, data: string) =>
        f.server.harness.commit(
          (tx) =>
            tx.appendEntry(id, {
              kind: 'pi.tool-result',
              model: [
                {
                  role: 'toolResult',
                  toolCallId: 'screenshot',
                  toolName: 'screenshot',
                  isError: false,
                  content: [{ ...image, data }],
                  timestamp: Date.now(),
                },
              ],
            }),
          context,
        )
      const screenshot = await appendImage(side, image.data)
      await appendImage(f.main, Buffer.from('main').toString('base64'))
      const target = await f.server.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        context,
      )
      const text = `image ${tool} ${ref}`
      await f.call(side, tool, {
        ...(tool === 'branch'
          ? { prompt: text, root: ROOT_CONVERSATION_ID, isolated: false }
          : { to: `#${target.id}`, text, reply: false }),
        images: ref === 'latest' ? ref : screenshot.id,
      })
      await until(async () =>
        (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.some(
          (message) => message.text === text && message.entry !== undefined,
        ),
      )
      const sent = (await f.server.harness.snapshot(
        Messages,
        ROOT_CONVERSATION_ID,
        context,
      ))!.messages.find((message) => message.text === text)!
      expect(sent).toMatchObject({ from: f.main, images: { entry: screenshot.id, count: 1 } })
      const delivered = (await entries(f.server, sent.to as number)).find(
        (entry) => entry.id === sent.entry,
      )!
      expect(
        delivered.model!.flatMap((message) =>
          typeof message.content === 'string'
            ? []
            : message.content.filter((block) => block.type === 'image'),
        ),
      ).toEqual([image])
    },
  )
})
