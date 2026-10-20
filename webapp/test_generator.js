#!/usr/bin/env node
/* Tests for generator.js. Run:  node test_generator.js
 * Regenerate the sample (placeholder) files in the bundle directory:  node test_generator.js --write
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

require('./generator.js');
const G = globalThis.SsrHa;
const BUNDLE_DIR = path.resolve(__dirname, '..');
const README = path.join(BUNDLE_DIR, 'README.md');
const TABLE_BEGIN = '<!-- INPUTS-TABLE:BEGIN -->';
const TABLE_END = '<!-- INPUTS-TABLE:END -->';

/* Markdown inputs reference for README.md, generated from the same FIELDS the web app uses. */
function inputsTable() {
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const text = (s) => cell(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out = [];
  for (const section of G.SECTIONS) {
    out.push('', `#### ${section.title}`, '');
    out.push('| # | Input | Required | Default | Description | File: key |', '|---|---|---|---|---|---|');
    for (const f of G.FIELDS.filter((x) => x.section === section.id)) {
      const n = G.FIELDS.indexOf(f) + 1;
      let def = '-';
      if (f.kind === 'checkbox') def = `\`${Boolean(f.def)}\``;
      else if (f.def === '') def = '(empty)';
      else if (f.def !== undefined) def = `\`${f.def}\``;
      const ph = f.required ? ` Placeholder: \`${f.ph}\`` : '';
      const used = f.usedIn.map((u) => `\`${cell(u)}\``).join('<br>');
      out.push(`| ${n} | ${text(f.label)} | ${f.required ? 'Yes' : 'No'} | ${def} | ${text(f.help)}${ph} | ${used} |`);
    }
  }
  return `${out.join('\n')}\n`;
}

function readmeWithTable(readme) {
  const start = readme.indexOf(TABLE_BEGIN);
  const end = readme.indexOf(TABLE_END);
  if (start < 0 || end < start) throw new Error('README.md is missing the INPUTS-TABLE markers');
  return `${readme.slice(0, start + TABLE_BEGIN.length)}${inputsTable()}${readme.slice(end)}`;
}

if (process.argv.includes('--write')) {
  for (const f of G.buildGeneratedFiles(G.defaults())) {
    fs.writeFileSync(path.join(BUNDLE_DIR, f.path), f.content);
    console.log(`wrote ${f.path}`);
  }
  fs.writeFileSync(README, readmeWithTable(fs.readFileSync(README, 'utf8')));
  console.log('updated README.md inputs table');
  process.exit(0);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const filled = () => Object.assign(G.defaults(), {
  resourceGroup: 'ssr-rg',
  location: 'eastus',
  virtualNetworkName: 'ssr-vnet',
  controlSubnetName: 'conductor',
  managedIdentity: 'ssr-id',
  adminPublicKeyData: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 user@host',
  node0PrivateIp: '10.0.1.10',
  node1PrivateIp: '10.0.1.11',
  artifactoryUser: 'user',
  artifactoryToken: 'tok"en\\with-quotes',
  adminPasswordHash: G.sha512Crypt('admin-password', 'adminsalt'),
  rootPasswordHash: G.sha512Crypt('root-password', 'rootsalt'),
  t128PasswordHash: G.sha512Crypt('t128-password', 't128salt'),
  haPeerPassword: 'Temp "peer" pa$$:word',
  dnsServers: '168.63.129.16, 8.8.8.8',
  ntpServers: 'time.windows.com',
  timezone: 'America/New_York',
});

const extractJson = (cloudInit) => JSON.parse(cloudInit.slice(cloudInit.indexOf('{'), cloudInit.lastIndexOf('}') + 1));

test('sample files on disk match generator output for empty inputs', () => {
  for (const f of G.buildGeneratedFiles(G.defaults())) {
    const onDisk = fs.readFileSync(path.join(BUNDLE_DIR, f.path), 'utf8');
    assert.strictEqual(onDisk, f.content, `${f.path} is stale; run: node test_generator.js --write`);
  }
});

test('README inputs table matches the field definitions', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.strictEqual(readme, readmeWithTable(readme), 'README.md inputs table is stale; run: node test_generator.js --write');
  for (const f of G.FIELDS) assert.ok(readme.includes(`| ${f.label.replace(/</g, '&lt;')} |`), f.label);
});

test('sha512 matches node crypto', () => {
  for (let len = 0; len < 600; len += 7) {
    const data = crypto.randomBytes(len);
    assert.strictEqual(Buffer.from(G.sha512(data)).toString('hex'), crypto.createHash('sha512').update(data).digest('hex'));
  }
});

test('sha512Crypt matches the reference test vector', () => {
  assert.strictEqual(
    G.sha512Crypt('Hello world!', 'saltstring'),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1',
  );
  const vectors = process.env.SHA512_CRYPT_VECTORS;
  if (vectors) {
    for (const [pw, salt, expected] of JSON.parse(fs.readFileSync(vectors, 'utf8'))) {
      assert.strictEqual(G.sha512Crypt(pw, salt), expected, `password ${JSON.stringify(pw)}`);
    }
  }
});

test('sha512Crypt output matches the onboarding schema pattern', () => {
  const pattern = /^\$6\$[A-Za-z0-9./]{1,16}\$[A-Za-z0-9./]{86}$/;
  for (let i = 0; i < 5; i++) assert.match(G.sha512Crypt(`pw${i}`, G.randomSalt()), pattern);
});

test('filled inputs validate cleanly and contain no placeholders', () => {
  const values = filled();
  const result = G.validate(values);
  assert.deepStrictEqual(result.fieldErrors, {});
  assert.deepStrictEqual(result.missing, []);
  for (const f of G.buildGeneratedFiles(values)) assert.ok(!/<input-/.test(f.content), f.path);
});

test('node0/node1 onboarding configs carry the HA settings', () => {
  const values = filled();
  const byPath = Object.fromEntries(G.buildGeneratedFiles(values).map((f) => [f.path, f]));
  const [p0, p1, c0, c1] = [G.FILES.p0, G.FILES.p1, G.FILES.c0, G.FILES.c1].map((p) => byPath[p]);
  const n0 = extractJson(c0.content);
  const n1 = extractJson(c1.content);
  assert.strictEqual(n0['node-name'], 'node0');
  assert.strictEqual(n1['node-name'], 'node1');
  assert.strictEqual(n0.name, 'Conductor-node0');
  assert.strictEqual(n0['cloud-provider'], 'azure');
  assert.ok(!('clustered' in n0) && !('clustered' in n1));
  assert.deepStrictEqual(n0['initializer-overrides'], { 'router-name': 'Conductor', 'node-ip': '10.0.1.10', timezone: 'America/New_York' });
  assert.deepStrictEqual(n1['initializer-overrides'], {
    'router-name': 'Conductor',
    'node-ip': '10.0.1.11',
    'ha-peer-ip': '10.0.1.10',
    'ha-peer-name': 'node0',
    'learn-from-ha-peer': true,
    'ha-peer-username': 't128',
    'unsafe-ha-peer-password': 'Temp "peer" pa$$:word',
    timezone: 'America/New_York',
  });
  assert.strictEqual(n1['artifactory-password'], 'tok"en\\with-quotes');
  assert.deepStrictEqual(n0['dns-servers'], ['168.63.129.16', '8.8.8.8']);

  const params0 = JSON.parse(p0.content).parameters;
  const params1 = JSON.parse(p1.content).parameters;
  assert.strictEqual(params0.controlPrivateIp.value, '10.0.1.10');
  assert.strictEqual(params0.haPeerPrivateIp.value, '10.0.1.11');
  assert.strictEqual(params1.controlPrivateIp.value, '10.0.1.11');
  assert.strictEqual(params1.haPeerPrivateIp.value, '10.0.1.10');
  assert.strictEqual(params0.availabilityZone.value, '1');
  assert.strictEqual(params1.availabilityZone.value, '2');
  assert.strictEqual(params0.createPublicIp.value, false);
});

test('params files only use parameters defined in the template', () => {
  const template = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'conductor_template.json'), 'utf8'));
  const defined = new Set(Object.keys(template.parameters));
  const paramFiles = G.buildGeneratedFiles(filled()).filter((f) => f.path.endsWith('-params.json'));
  for (const f of paramFiles) {
    for (const name of Object.keys(JSON.parse(f.content).parameters)) assert.ok(defined.has(name), `${f.path}: ${name}`);
  }
  const required = Object.entries(template.parameters).filter(([, p]) => !('defaultValue' in p)).map(([n]) => n);
  const provided = new Set([...Object.keys(JSON.parse(paramFiles[0].content).parameters), 'customData']);
  for (const name of required) assert.ok(provided.has(name), `required template parameter ${name} not provided`);
});

/* Splits a PowerShell command line made of bare words and single-quoted strings (as generated) into arguments. */
function parsePowerShellArgs(line) {
  const args = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') { i++; continue; }
    let arg = '';
    if (line[i] === "'") {
      i++;
      for (;;) {
        if (i >= line.length) throw new Error('unterminated quote');
        if (line[i] === "'" && line[i + 1] === "'") { arg += "'"; i += 2; continue; }
        if (line[i] === "'") { i++; break; }
        arg += line[i++];
      }
    } else {
      while (i < line.length && line[i] !== ' ') {
        if (/[<>|;&$`"(){}@]/.test(line[i]) && arg === '' ) throw new Error(`unquoted special character in ${line.slice(i, i + 20)}`);
        arg += line[i++];
      }
    }
    args.push(arg);
  }
  return args;
}

test('MOP commands are single lines with safe PowerShell quoting and valid shell scripts', () => {
  const values = filled();
  values.haPeerPassword = `Tricky 'quote' "dq" $HOME \`back\` ;|&`;
  const steps = G.mopSteps(values);
  assert.strictEqual(steps.length, 10);
  for (const step of steps) {
    assert.ok(!step.cmd.includes('\n'), `${step.title} is not a single line`);
    const args = parsePowerShellArgs(step.cmd);
    assert.strictEqual(args[0], 'az');
    const i = args.indexOf('--scripts');
    if (i > 0) execFileSync('bash', ['-n', '-c', args[i + 1]]);
  }
  const open = parsePowerShellArgs(steps[4].cmd);
  const script = open[open.indexOf('--scripts') + 1];
  const echoed = execFileSync('bash', ['-c', script.split('; ')[1].replace('| chpasswd', '')]).toString().trim();
  assert.strictEqual(echoed, `t128:${values.haPeerPassword}`);
  assert.ok(script.includes(`Match User t128 Address ${values.node1PrivateIp}/32`));
  const close = parsePowerShellArgs(steps[7].cmd);
  assert.ok(close[close.indexOf('--scripts') + 1].includes(`usermod -p '${values.t128PasswordHash}' t128`));
  const deploy = parsePowerShellArgs(steps[2].cmd);
  assert.deepStrictEqual(deploy.slice(deploy.indexOf('--parameters'), deploy.indexOf('--parameters') + 3),
    ['--parameters', '@conductor-node0-params.json', 'customData=@conductor-node0-cloud-init.txt']);
});

test('cross-field validation', () => {
  const values = filled();
  values.node1PrivateIp = values.node0PrivateIp;
  values.availabilitySetName = 'my-set';
  values.adminPasswordHash = 'clear-text';
  const { fieldErrors } = G.validate(values);
  assert.ok(fieldErrors.node1PrivateIp);
  assert.ok(fieldErrors.availabilitySetName);
  assert.ok(fieldErrors.adminPasswordHash);
});

test('zip archive is readable by unzip', () => {
  const zip = G.makeZip([{ path: 'dir/a.txt', content: 'hello\n' }, { path: 'dir/s.sh', content: '#!/bin/sh\necho hi\n' }]);
  const tmp = path.join(require('os').tmpdir(), `ssr-ha-test-${process.pid}.zip`);
  fs.writeFileSync(tmp, zip);
  try {
    execFileSync('unzip', ['-tq', tmp]);
    assert.strictEqual(execFileSync('unzip', ['-p', tmp, 'dir/a.txt']).toString(), 'hello\n');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('index.html is up to date with its sources', () => {
  execFileSync('python3', [path.join(__dirname, 'build.py'), '--check'], { stdio: 'pipe' });
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`ok   - ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${t.name}\n       ${err.message.split('\n').join('\n       ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
