-- s2s/spawn.lua — the ONLY module that knows a binary exists.
--
-- One action = one process. argv is always
--   { bin, group, action, <abs note>, args..., '--json' }
-- with --json last, always.

local M = {}

local uv = vim.uv or vim.loop

local MARKERS = { '.s2sconfig.json', '.git', 'package.json' }

local function abs(path)
  if type(path) ~= 'string' or path == '' then
    return nil
  end
  return vim.fn.fnamemodify(path, ':p')
end

--- Build the argv for one invocation. `--json` is appended unconditionally.
---@param spec { bin: string, group: string, action?: string, note?: string, args?: string[] }
---@return string[]
function M.argv(spec)
  local argv = { spec.bin, spec.group }
  if spec.action and spec.action ~= '' then
    argv[#argv + 1] = spec.action
  end
  if spec.note and spec.note ~= '' then
    argv[#argv + 1] = abs(spec.note) or spec.note
  end
  local extra = spec.args or {}
  for i = 1, #extra do
    argv[#argv + 1] = tostring(extra[i])
  end
  argv[#argv + 1] = '--json'
  return argv
end

--- Walk up from the note looking for a project marker. Never reads the note.
---@param note_path string|nil
---@return string
function M.resolve_cwd(note_path)
  local dir = note_path and abs(note_path) and vim.fn.fnamemodify(abs(note_path), ':h') or nil
  local seen = {}
  while dir and dir ~= '' and not seen[dir] do
    seen[dir] = true
    for _, marker in ipairs(MARKERS) do
      if uv.fs_stat(dir .. '/' .. marker) then
        return dir
      end
    end
    local parent = vim.fn.fnamemodify(dir, ':h')
    if parent == dir or parent == '' then
      break
    end
    dir = parent
  end
  return vim.fn.getcwd()
end

local function parse_stdout(stdout)
  if type(stdout) ~= 'string' or stdout:match('^%s*$') then
    return nil, 'no JSON result on stdout (empty output)'
  end
  local ok, decoded = pcall(vim.json.decode, stdout)
  if not ok or type(decoded) ~= 'table' then
    return nil, 'not a JSON result — is `bin` the s2s binary?'
  end
  return decoded, nil
end

--- Run one invocation. on_done always fires exactly once, in a scheduled
--- context, with { code, stdout, stderr, json, parse_error }.
---@param spec table
---@param on_done fun(payload: table)
function M.run(spec, on_done)
  local argv = M.argv(spec)
  local opts = { text = true, cwd = spec.cwd }
  if spec.timeout then
    opts.timeout = spec.timeout
  end

  local finished = false
  local function finish(payload)
    if finished then
      return
    end
    finished = true
    vim.schedule(function()
      on_done(payload)
    end)
  end

  local ok, err = pcall(vim.system, argv, opts, function(obj)
    obj = obj or {}
    local code = obj.code
    local stdout = obj.stdout or ''
    local stderr = obj.stderr or ''
    local json, parse_error = parse_stdout(stdout)
    if not json and (code == nil or code == -1) and stdout == '' then
      parse_error = 'could not start the binary — check `bin` in setup()'
    end
    finish({
      code = code,
      signal = obj.signal,
      stdout = stdout,
      stderr = stderr,
      json = json,
      parse_error = parse_error,
    })
  end)

  if not ok then
    finish({
      code = -1,
      stdout = '',
      stderr = '',
      json = nil,
      parse_error = 'could not start the binary — check `bin` in setup()',
    })
  end
end

return M
