-- s2s/init.lua — public API for nvim-s2s.
--
-- Thin wrapper: build argv, spawn the binary, format the one JSON document.
-- The note file is never read, parsed, or written by this plugin.

local M = {}

local api = vim.api
local uv = vim.uv or vim.loop

local spawn = require('s2s.spawn')
local state = require('s2s.state')
local ui = require('s2s.ui')

local defaults = {
  bin = 's2s',
  cwd = 'auto',
  notify = true,
  open = true,
  copy_cid = false,
  confirm_revoke = true,
  confirm_save = true,
  abbrev = true,
  -- A browser cannot resolve `name.eth`, so the binary's prodUrl is rewritten
  -- through a public ENS gateway before it is shown or opened. 'limo' | 'link'
  -- (or false to display exactly what the binary returned).
  gateway = 'limo',
  timeout = nil,
}

local opts = vim.deepcopy(defaults)

--- Effective options (health, completion and init all read this).
---@return table
function M.get_opts()
  return opts
end

local function resolve_bin(bin)
  bin = (type(bin) == 'string' and bin ~= '') and bin or 's2s'
  if bin:sub(1, 1) == '/' or bin:match('^%a:[/\\]') then
    return bin
  end
  local resolved = vim.fn.exepath(bin)
  if type(resolved) == 'string' and resolved ~= '' then
    return resolved
  end
  return bin
end

---@param user_opts table|nil
---@return table
function M.setup(user_opts)
  local o = vim.tbl_extend('force', vim.deepcopy(defaults), user_opts or {})
  o.bin = resolve_bin(o.bin)
  opts = o
  pcall(function()
    local commands = require('s2s.commands')
    commands.define()
    commands.set_abbrev(o.abbrev ~= false)
  end)
  return o
end

local function note_path(buf)
  buf = buf or api.nvim_get_current_buf()
  if not api.nvim_buf_is_valid(buf) then
    return nil
  end
  local name = api.nvim_buf_get_name(buf)
  if type(name) ~= 'string' or name == '' then
    return nil
  end
  return vim.fn.fnamemodify(name, ':p')
end

local function cwd_for(note)
  if type(opts.cwd) == 'string' and opts.cwd ~= 'auto' and opts.cwd ~= '' then
    return opts.cwd
  end
  if note then
    return spawn.resolve_cwd(note)
  end
  return vim.fn.getcwd()
end

-- One WARN per buffer, ever, about frontmatter we refused to reload.
local frontmatter_warned = {}

--- The binary says it rewrote the note's frontmatter. Check that the file on
--- disk actually changed during the run: if it didn't, the write-back failed on
--- the binary's side (or a formatter/`fsync` race), and no reload can help.
local function verify_writeback(path, before, result)
  if type(result) ~= 'table' or result.frontmatterWritten ~= true then
    return
  end
  if type(path) ~= 'string' or path == '' or type(before) ~= 'table' then
    return
  end
  local after = uv.fs_stat(path)
  if type(after) ~= 'table' then
    ui.error(string.format('s2s: reported a frontmatter write-back but %s is gone', path))
    return
  end
  local same = after.mtime and before.mtime and after.mtime.sec == before.mtime.sec
    and after.mtime.nsec == before.mtime.nsec
    and after.size == before.size
  if same then
    ui.error(
      string.format(
        's2s: the binary reported a frontmatter write-back but %s did not change on disk',
        vim.fn.fnamemodify(path, ':t')
      )
    )
  end
end

local function sync_note(buf, result)
  if type(result) ~= 'table' or result.frontmatterWritten ~= true then
    return
  end
  if not buf or not api.nvim_buf_is_valid(buf) then
    return
  end
  if vim.bo[buf].modified then
    if not frontmatter_warned[buf] then
      frontmatter_warned[buf] = true
      ui.error(
        "s2s: the note's frontmatter changed on disk — `:e!` to take it, `:w` now will clobber it"
      )
    end
    return
  end
  frontmatter_warned[buf] = nil
  pcall(api.nvim_buf_call, buf, function()
    vim.cmd('silent! edit!')
  end)
end

--- The link to show: the binary's render URL, `.eth` rewritten through the
--- configured gateway so it is openable. nil when there is no render URL.
local function link_target(action, result)
  if action ~= 'preview' and action ~= 'publish' then
    return nil
  end
  local ok, target = pcall(function()
    return require('s2s.format').open_target(result, opts.gateway)
  end)
  if not ok or type(target) ~= 'table' or type(target.url) ~= 'string' then
    return nil
  end
  local render = type(result.render) == 'table' and result.render or {}
  if target.raw_url ~= render.previewUrl and target.raw_url ~= render.prodUrl then
    return nil
  end
  return target
end

local function maybe_open(action, result, link)
  if not opts.open or not link then
    return
  end
  pcall(vim.ui.open, link.url)
end

local function copy_cid(action, result)
  if not opts.copy_cid or action ~= 'upload' then
    return
  end
  local cid = type(result) == 'table' and result.cid or nil
  if type(cid) == 'string' and cid ~= '' then
    pcall(vim.fn.setreg, '+', cid)
  end
end

local function is_failure(result, code)
  local ok, failed = pcall(function()
    return require('s2s.format').is_failure(result, code)
  end)
  if ok then
    return failed == true
  end
  return code ~= 0 or (type(result) == 'table' and result.ok == false)
end

--- Handle one finished invocation. buf == nil for buffer-less commands.
local function finish(buf, action, started, payload, path, before)
  local code = payload.code
  local result = payload.json
  local ms = math.floor((uv.hrtime() - started) / 1e6)

  if buf then
    state.set_busy(buf, false)
  end

  -- Keep failures inspectable: `:S2sLast` is often wanted right after a red
  -- notify, and the envelope (or the "not JSON" diagnostic) is what to read.
  local function dump_raw()
    local ok, path = pcall(function()
      local dir = vim.fn.stdpath('cache') .. '/nvim-s2s'
      vim.fn.mkdir(dir, 'p')
      local p = dir .. '/last-failure.log'
      local fd = io.open(p, 'w')
      if not fd then
        return nil
      end
      fd:write(
        string.format(
          '# s2s %s — exit %s — %s\n# argv: %s\n\n--- stdout (%d bytes) ---\n%s\n\n--- stderr ---\n%s\n',
          tostring(action),
          tostring(code),
          os.date('%Y-%m-%d %H:%M:%S'),
          table.concat(payload.argv or {}, ' '),
          #(payload.stdout or ''),
          payload.stdout or '',
          payload.stderr or ''
        )
      )
      fd:close()
      return p
    end)
    return ok and path or nil
  end

  local function remember_failure(stored)
    if not buf then
      return
    end
    if type(stored) ~= 'table' then
      stored = {
        ok = false,
        error = payload.parse_error or string.format('s2s exited %s', tostring(code)),
      }
    end
    state.set(buf, {
      action = action,
      result = stored,
      code = code,
      at = os.time(),
      ms = ms,
      raw_stdout = payload.stdout,
      raw_stderr = payload.stderr,
      dump = dump_raw(),
    })
  end

  if type(result) ~= 'table' then
    ui.failure(buf, action, {
      code = code,
      stderr = payload.stderr,
      parse_error = payload.parse_error or 'not a JSON result — is `bin` the s2s binary?',
      signal = payload.signal,
    })
    remember_failure(nil)
    return
  end

  if code == 0 and not is_failure(result, code) then
    local link = link_target(action, result)
    if buf then
      state.set(buf, {
        action = action,
        result = result,
        code = code,
        at = os.time(),
        ms = ms,
        link = link,
      })
    end
    if opts.notify then
      ui.result(buf, action, result, code, ms, link)
    end
    verify_writeback(path, before, result)
    sync_note(buf, result)
    copy_cid(action, result)
    maybe_open(action, result, link)
    return
  end

  ui.failure(buf, action, {
    code = code,
    result = result,
    stderr = (code == 1 or code == 2) and nil or payload.stderr,
    signal = payload.signal,
  })
  remember_failure(result)
end

--- s2s only ever sees the file on disk, never the buffer. So: a new note has to
--- be written before anything can be uploaded, and unsaved edits mean the
--- version on screen is *not* what gets uploaded. Both are asked about, not
--- guessed at (`confirm_save = false` opts out and always uses the disk file).
---@param buf integer
---@param path string
---@param proceed fun()
local function ensure_saved(buf, path, proceed)
  local exists = uv.fs_stat(path) ~= nil
  local dirty = vim.bo[buf].modified == true
  if exists and not dirty then
    proceed()
    return
  end
  if not exists and not dirty then
    -- Named but empty and never written: there is nothing to send either way.
    ui.warn('s2s: this note is not on disk yet — write it first')
    return
  end
  if opts.confirm_save ~= true then
    proceed()
    return
  end

  local name = vim.fn.fnamemodify(path, ':t')
  local choices, prompt
  if not exists then
    choices = { 'Save, then continue', 'Cancel' }
    prompt = string.format('s2s: %s is not on disk yet — save it first?', name)
  else
    choices = {
      'Save, then continue',
      'Continue with the file on disk',
      'Cancel',
    }
    prompt = string.format('s2s: %s has unsaved changes — save before uploading?', name)
  end

  vim.ui.select(choices, { prompt = prompt }, function(choice)
    if choice == 'Save, then continue' then
      local saved = pcall(function()
        api.nvim_buf_call(buf, function()
          vim.cmd('silent write')
        end)
      end)
      if not saved or uv.fs_stat(path) == nil then
        ui.error(string.format('s2s: could not save %s — nothing uploaded', name))
        return
      end
      proceed()
    elseif choice == 'Continue with the file on disk' then
      proceed()
    end
  end)
end

local function split_args(args)
  if args == nil then
    return {}
  end
  if type(args) == 'table' then
    local out = {}
    for i = 1, #args do
      out[i] = tostring(args[i])
    end
    return out
  end
  local out = {}
  for word in tostring(args):gmatch('%S+') do
    out[#out + 1] = word
  end
  return out
end

local spawn_note

local function run(buf, group, action, args)
  buf = buf or api.nvim_get_current_buf()
  local path = note_path(buf)
  if not path then
    ui.warn('s2s: this buffer has no file — save the note first')
    return
  end
  if state.is_busy(buf) then
    ui.warn(string.format('s2s: %s is already running for this buffer', action))
    return
  end

  ensure_saved(buf, path, function()
    spawn_note(buf, group, action, path, args)
  end)
end

function spawn_note(buf, group, action, path, args)
  local started = uv.hrtime()
  local spec = {
    bin = opts.bin,
    group = group,
    action = action,
    note = path,
    args = split_args(args),
    cwd = cwd_for(path),
    timeout = opts.timeout,
    buf = buf,
  }

  local before = uv.fs_stat(path)
  state.set_busy(buf, true)
  if opts.notify then
    ui.busy(buf, action)
  end
  spawn.run(spec, function(payload)
    finish(buf, action, started, payload, path, before)
  end)
end

-- Buffer-less pass-through commands (`publication new`, `config …`).
local function run_raw(label, group, action, args)
  local argv = split_args(args)
  local started = uv.hrtime()
  local spec = {
    bin = opts.bin,
    group = group,
    action = action,
    args = argv,
    cwd = cwd_for(nil),
    timeout = opts.timeout,
  }

  if opts.notify then
    ui.busy(0, label)
  end
  spawn.run(spec, function(payload)
    finish(nil, label, started, payload, nil, nil)
  end)
end

---@param buf integer|nil
---@param args string|string[]|nil flags forwarded to the binary (e.g. --publication <ens>)
function M.upload(buf, args)
  run(buf, 'author', 'upload', args)
end

---@param buf integer|nil
---@param args string|string[]|nil
function M.propose(buf, args)
  run(buf, 'author', 'propose', args)
end

---@param buf integer|nil
---@param args string|string[]|nil
function M.preview(buf, args)
  run(buf, 'author', 'preview', args)
end

---@param buf integer|nil
---@param args string|string[]|nil
function M.publish(buf, args)
  run(buf, 'author', 'publish', args)
end

--- Destructive (retracts on-chain): confirms first, opt-out via confirm_revoke.
---@param buf integer|nil
function M.revoke(buf, args)
  buf = buf or api.nvim_get_current_buf()
  local function go()
    run(buf, 'author', 'revoke', args)
  end
  if not opts.confirm_revoke then
    go()
    return
  end
  local name = vim.fn.fnamemodify(api.nvim_buf_get_name(buf), ':t')
  vim.ui.select({ 'Yes, revoke', 'No, cancel' }, {
    prompt = string.format('s2s: revoke %s on-chain?', name ~= '' and name or 'this note'),
  }, function(choice)
    if choice and choice:match('^Yes') then
      go()
    end
  end)
end

--- `:S2S new <name> --repo <o/r> …` — args go through verbatim.
---@param args string|string[]|nil
function M.new(args)
  run_raw('new', 'publication', 'new', split_args(args))
end

--- `:S2sConfig <set|get|unset|list|path> …` — args go through verbatim.
---@param args string|string[]|nil
function M.config(args)
  local argv = split_args(args)
  local action = table.remove(argv, 1)
  run_raw('config', 'config', action, argv)
end

---@param buf integer|nil
---@return boolean
function M.last(buf)
  return ui.detail(buf)
end

function M.health()
  local ok = pcall(vim.cmd, 'checkhealth s2s')
  if not ok then
    pcall(function()
      require('s2s.health').check()
    end)
  end
end

function M.help()
  local lines = {
    's2s — Soul2Soul from Neovim (thin wrapper over the s2s binary)',
    '',
    'Commands (:s2s expands to :S2S):',
    '  :S2S upload [--publication <ens>]   author upload  (IPFS + pins)',
    '  :S2S propose                        author propose (on-chain offer)',
    '  :S2S preview                        author preview (render + URL)',
    '  :S2S publish                        author publish (all-in-one)',
    '  :S2S revoke                         author revoke  (confirms first)',
    '  :S2S new <name> --repo <o/r> …      publication new',
    '  :S2S config <set|get|unset|list|path> …',
    '  :S2S last                           last result for this buffer',
    '  :S2S health                         :checkhealth s2s',
    '  :S2S help                           this text',
    '',
    'Short forms resolve on unique prefix: up, prop, prev, pub, rev, cfg, …',
    '',
    'setup():',
    string.format('  bin            = %s', tostring(opts.bin)),
    string.format('  cwd            = %s', tostring(opts.cwd)),
    string.format('  notify         = %s', tostring(opts.notify)),
    string.format('  open           = %s', tostring(opts.open)),
    string.format('  copy_cid       = %s', tostring(opts.copy_cid)),
    string.format('  confirm_revoke = %s', tostring(opts.confirm_revoke)),
    string.format('  confirm_save   = %s', tostring(opts.confirm_save)),
    string.format('  abbrev         = %s', tostring(opts.abbrev)),
    string.format('  gateway        = %s', tostring(opts.gateway)),
    string.format('  timeout        = %s', tostring(opts.timeout)),
    '',
    'No default keymaps — see <Plug>(s2s_*).',
  }
  ui.notify(table.concat(lines, '\n'))
end

-- ===========================================================================
-- :S2S dispatcher
-- ===========================================================================

--- Words accepted by `:S2S`, long form included. Short forms are aliases.
local ACTION_ALIASES = {
  upload = 'upload',
  up = 'upload',
  propose = 'propose',
  prop = 'propose',
  preview = 'preview',
  prev = 'preview',
  publish = 'publish',
  pub = 'publish',
  revoke = 'revoke',
  rev = 'revoke',
  new = 'new',
  config = 'config',
  cfg = 'config',
  conf = 'config',
  last = 'last',
  result = 'last',
  health = 'health',
  check = 'health',
  help = 'help',
  ['?'] = 'help',
}

local ACTION_NAMES = {
  'upload',
  'propose',
  'preview',
  'publish',
  'revoke',
  'new',
  'config',
  'last',
  'health',
  'help',
}

--- Resolve one dispatcher word: alias, exact name, or a unique prefix.
---@param word string|nil
---@return string|nil action
function M.resolve_action(word)
  if type(word) ~= 'string' or word == '' then
    return nil
  end
  local low = word:lower()
  local alias = ACTION_ALIASES[low]
  if alias then
    return alias
  end
  local matches = {}
  for _, name in ipairs(ACTION_NAMES) do
    if name:sub(1, #low) == low then
      matches[#matches + 1] = name
    end
  end
  if #matches == 1 then
    return matches[1]
  end
  return nil
end

local BUFFER_ACTIONS = { upload = true, propose = true, preview = true, publish = true, revoke = true }

--- `:S2S <action> [args]` — the single entry point behind every mapping.
---@param args string|string[]|nil
function M.dispatch(args)
  local argv = split_args(args)
  local word = table.remove(argv, 1)
  if word == nil then
    M.help()
    return
  end
  local action = M.resolve_action(word)
  if not action then
    ui.warn(string.format('s2s: unknown action %q — try :S2S help', word))
    return
  end
  if BUFFER_ACTIONS[action] then
    M[action](nil, argv)
  elseif action == 'new' then
    M.new(argv)
  elseif action == 'config' then
    M.config(argv)
  elseif action == 'last' then
    M.last()
  elseif action == 'health' then
    M.health()
  else
    M.help()
  end
end

return M
