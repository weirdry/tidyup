import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import dockerDetector, { itemsFromUsage, parseSize, parseTimestamp, resolveDocker, tagsById } from '../skills/tidyup/scripts/lib/detectors/docker.mjs';
import { EXIT, main } from '../skills/tidyup/scripts/tidyup.mjs';
import { fakeDocker, makeHome, removeTree, runMain } from './helpers/fixtures.mjs';

const NOW = new Date('2026-10-16T00:00:00Z');
const OLD = '2026-09-01 10:00:00.123456789 +0000 UTC';
const RECENT = '2026-10-15 10:00:00 +0000 UTC';

const image = (id, repository, tag, containers, uniqueSize) => ({
  ID: `sha256:${id}`, Repository: repository, Tag: tag, Containers: containers,
  UniqueSize: uniqueSize, Size: uniqueSize, CreatedAt: '2026-09-01 10:00:00 +0900 KST',
});
const cache = (size, lastUsed, { inUse = 'false', shared = 'false' } = {}) => ({
  ID: `${size}-${lastUsed}`, Size: size, LastUsedAt: lastUsed, CreatedAt: lastUsed, InUse: inUse, Shared: shared,
});
const USAGE = {
  BuildCache: [
    cache('1GB', OLD),
    cache('500MB', OLD, { shared: 'true' }),
    cache('2GB', OLD, { inUse: 'true' }),
    cache('3GB', RECENT),
  ],
  Images: [
    image('aaa', '<none>', '<none>', '0', '100MB'),
    image('bbb', '<none>', '<none>', '1', '200MB'),
    image('ccc', 'app', 'dev', '0', '1.5GB'),
    image('ccc', 'app', 'latest', '0', '1.5GB'),
    image('ddd', 'postgres', '17', '1', '400MB'),
    image('eee', 'tool', '1.0', '0', '50MB'),
  ],
  Volumes: [
    { Name: 'db-data', Size: '16GB', Links: '0' },
    { Name: 'cache', Size: '1GB', Links: '1' },
  ],
};

describe('docker parsing', () => {
  test('sizes are decimal, as Docker prints them', () => {
    assert.equal(parseSize('0B'), 0);
    assert.equal(parseSize('24.58kB'), 24580);
    assert.equal(parseSize('1.223GB'), 1_223_000_000);
    assert.equal(parseSize('N/A'), null);
  });

  test('timestamps keep their offset', () => {
    assert.equal(parseTimestamp(OLD).toISOString(), '2026-09-01T10:00:00.123Z');
    assert.equal(parseTimestamp('2026-09-01 10:00:00 +0900 KST').toISOString(), '2026-09-01T01:00:00.000Z');
    assert.equal(parseTimestamp(''), null);
  });
});

// What the real `system df -v` shows: one row per image, with only its first tag.
const dfRows = (rows) => rows.filter((row, index) => rows.findIndex((other) => other.ID === row.ID) === index);
const derive = (usage, daemonId = 'daemon-a') =>
  itemsFromUsage({ ...usage, Images: dfRows(usage.Images) }, tagsById(usage.Images), daemonId, NOW);

describe('docker items', () => {
  const { items, skipped } = derive(USAGE);
  const byKind = (kind) => items.filter((item) => item.kind === kind);

  test('build cache counts only old records that are neither shared nor in use', () => {
    const [buildCache] = byKind('build-cache');
    assert.equal(buildCache.class, 'routine');
    assert.equal(buildCache.estimated_bytes, 1_000_000_000);
    assert.equal(buildCache.evidence.records, 1);
  });

  test('dangling images count only those unused by containers', () => {
    const [dangling] = byKind('dangling-images');
    assert.equal(dangling.class, 'routine');
    assert.equal(dangling.estimated_bytes, 100_000_000);
  });

  test('unused tagged images are review items with all their tags, largest first', () => {
    const images = byKind('image');
    assert.deepEqual(images.map((item) => item.evidence.refs), [['app:dev', 'app:latest'], ['tool:1.0']]);
    assert.ok(images.every((item) => item.class === 'review' && item.id));
    assert.deepEqual(skipped, []);
  });

  test('images with an unknown container count are reported, never candidates', () => {
    const usage = { Images: [image('fff', 'mystery', '1', 'N/A', '9GB'), image('ggg', '<none>', '<none>', 'N/A', '1GB')] };
    const result = derive(usage);
    assert.deepEqual(result.items, []);
    assert.match(result.skipped[0].reason, /2 image\(s\) not evaluated: container count unavailable/);
  });

  test('volumes are one judgment item without an ID', () => {
    const [volumes] = byKind('volumes');
    assert.equal(volumes.class, 'judgment');
    assert.equal(volumes.id, undefined);
    assert.equal(volumes.estimated_bytes, 17_000_000_000);
    assert.deepEqual(volumes.evidence.largest.map((v) => v.name), ['db-data', 'cache']);
  });

  test('IDs are bound to the daemon, and image IDs to their tags', () => {
    const other = derive(USAGE, 'daemon-b').items;
    assert.notEqual(other.find((item) => item.kind === 'build-cache').id, byKind('build-cache')[0].id);
    const retagged = derive({ ...USAGE, Images: [...USAGE.Images, image('eee', 'tool', '1.1', '0', '50MB')] }).items;
    const tool = (list) => list.find((item) => item.evidence.image_id === 'sha256:eee').id;
    assert.notEqual(tool(retagged), tool(items));
  });
});

describe('docker through the CLI', () => {
  let home;
  let docker;
  const cleanup = [];
  beforeEach(() => {
    home = makeHome();
    docker = fakeDocker({ images: USAGE.Images, volumes: USAGE.Volumes, buildCache: USAGE.BuildCache });
    cleanup.push(home, docker.dir);
  });
  after(() => cleanup.forEach(removeTree));

  // Docker calls without the pinned `--context <name>` prefix.
  const plainCalls = () => docker.calls().map((args) => (args[0] === '--context' ? args.slice(2) : args));
  const scanItems = async () => JSON.parse((await runMain(main, ['scan', '--json'], { home, percent: 5, docker })).stdout).items;
  const idOf = (items, kind) => items.find((item) => item.kind === kind).id;

  test('scan lists docker items with labels in the table', async () => {
    const result = await runMain(main, ['scan'], { home, percent: 5, docker });
    assert.equal(result.code, EXIT.urgent);
    assert.match(result.stdout, /routine\s+.*Docker build cache unused for 7\+ days/);
    assert.match(result.stdout, /review\s+.*Docker image app:dev, app:latest/);
    assert.match(result.stdout, /-\s+judgment\s+.*Docker volumes \(2; 1 unattached\)/);
  });

  test('apply prunes old build cache and dangling images with docker commands', async () => {
    const items = await scanItems();
    const result = await runMain(main, ['apply', idOf(items, 'build-cache'), idOf(items, 'dangling-images'), '--json'], { home, percent: 5, docker });
    assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
    const calls = plainCalls();
    assert.ok(calls.some((args) => args.join(' ') === 'builder prune --force --filter until=168h'));
    assert.ok(calls.some((args) => args.join(' ') === 'image prune --force'));
  });

  test('a review image is refused without --reviewed and removed tag by tag with it', async () => {
    const id = (await scanItems()).find((item) => item.kind === 'image').id;
    const refused = await runMain(main, ['apply', id, '--json'], { home, percent: 5, docker });
    assert.equal(refused.code, EXIT.error);
    assert.match(JSON.parse(refused.stdout).outcomes[0].reason, /requires --reviewed/);

    const applied = await runMain(main, ['apply', '--reviewed', id, '--json'], { home, percent: 5, docker });
    assert.equal(applied.code, EXIT.ok, applied.stdout);
    const removals = plainCalls().filter(([a, b]) => a === 'image' && b === 'rm').map((args) => args[2]);
    assert.deepEqual(removals, ['app:dev', 'app:latest']);
  });

  test('an image whose tags changed or that a container now uses is refused', async () => {
    const id = (await scanItems()).find((item) => item.kind === 'image').id;
    docker.update({ images: [...USAGE.Images, image('ccc', 'app', 'extra', '0', '1.5GB')] });
    const changed = await runMain(main, ['apply', '--reviewed', id, '--json'], { home, percent: 5, docker });
    assert.equal(changed.code, EXIT.error);
    assert.equal(JSON.parse(changed.stdout).outcomes[0].outcome, 'refused');

    docker.update({ images: USAGE.Images, ancestors: ['sha256:ccc'] });
    const used = await runMain(main, ['apply', '--reviewed', id, '--json'], { home, percent: 5, docker });
    assert.equal(used.code, EXIT.error);
    assert.match(JSON.parse(used.stdout).outcomes[0].reason, /used by a container/);
    assert.equal(plainCalls().some(([a, b]) => a === 'image' && b === 'rm'), false);
  });

  test('every docker call in an operation is pinned to the starting context', async () => {
    const items = await scanItems();
    await runMain(main, ['apply', idOf(items, 'dangling-images'), '--json'], { home, percent: 5, docker });
    const calls = docker.calls().filter((args) => !(args[0] === 'context' && args[1] === 'show'));
    assert.ok(calls.length > 0);
    assert.ok(calls.every((args) => args[0] === '--context' && args[1] === 'fake-ctx'), JSON.stringify(calls));
  });

  test('with DOCKER_HOST set, the environment pins the endpoint and no context is passed', async () => {
    await runMain(main, ['scan', '--json'], { home, percent: 5, docker, env: { HOME: home, TIDYUP_DOCKER: docker.bin, DOCKER_HOST: 'unix:///fake.sock' } });
    assert.ok(docker.calls().every((args) => args[0] !== '--context'));
  });

  test('an item is refused when the daemon behind the context changed', async () => {
    const [candidate] = (await scanItems()).filter((item) => item.kind === 'image');
    docker.update({ id: 'daemon-b' });
    const verdict = await dockerDetector.evaluate(candidate, { env: { HOME: home, TIDYUP_DOCKER: docker.bin }, now: new Date() });
    assert.deepEqual(verdict, { eligible: false, reason: 'docker daemon changed' });
  });

  test('an unreachable daemon is reported as skipped', async () => {
    docker.update({ up: false });
    const report = JSON.parse((await runMain(main, ['scan', '--json'], { home, percent: 5, docker })).stdout);
    assert.deepEqual(report.items, []);
    assert.match(report.skipped[0].reason, /daemon not reachable/);
  });

  test('an invalid TIDYUP_DOCKER is an error, not a silent fallback', async () => {
    await assert.rejects(resolveDocker({ TIDYUP_DOCKER: '/nonexistent/docker' }), /not executable/);
  });
});
