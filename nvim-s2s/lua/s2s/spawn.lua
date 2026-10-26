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

-- Top-level `{...}` spans in a text, respecting strings/escapes. The binary is
-- allowed to put human progress on stdout by accident (its durability legs run
-- fire-and-forget), so the result document is located, not assumed to be the
-- whole buffer.
---@param text string
---@return string[]
local function top_level_objects(text)
  local out = {}
  local depth, start, in_str, esc = 0, nil, false, false
  for i = 1, #text do
    local c = text:sub(i, i)
    if in_str then
      if esc then
        esc = false
      elseif c == '\\' then
        esc = true
      elseif c == '"' then
        in_str = false
      end
    elseif c == '"' then
      in_str = true
    elseif c == '{' then
      if depth == 0 then
        start = i
      end
      depth = depth + 1
    elseif c == '}' then
      if depth > 0 then
        depth = depth - 1
        if depth == 0 and start then
          out[#out + 1] = text:sub(start, i)
          start = nil
        end
      end
    end
  end
  return out
end

local function decode_object(text)
  if type(text) ~= 'string' or text == '' then
    return nil
  end
  local ok, decoded = pcall(vim.json.decode, text)
  if ok and type(decoded) == 'table' then
    return decoded
  end
  return nil
end

--- The result document inside stdout: the whole buffer, or the most
--- result-shaped JSON object in it. Stray log objects (a durability leg
--- reporting `{"leg":…}`) are outranked by anything carrying a result field.
---@param text string
---@return table|nil
function M.extract_json(text)
  if type(text) ~= 'string' or text:match('^%s*$') then
    return nil
  end
  local whole = decode_object(text)
  if whole then
    return whole
  end
  local found = top_level_objects(text)
  local best, best_score = nil, -1
  for i = #found, 1, -1 do
    local decoded = decode_object(found[i])
    if decoded then
      local score = 0
      if decoded.action ~= nil then
        score = 3
      elseif decoded.error ~= nil or decoded.ok ~= nil then
        score = 2
      elseif decoded.config ~= nil or decoded.version ~= nil or decoded.help ~= nil then
        score = 2
      end
      if score > best_score or (score == best_score and best == nil) then
        best, best_score = decoded, score
      end
    end
  end
  return best
end

local function first_line(text)
  if type(text) ~= 'string' then
    return nil
  end
  for line in text:gmatch('[^\r\n]+') do
    if not line:match('^%s*$') then
      local trimmed = line:gsub('^%s+', '')
      return #trimmed > 120 and (trimmed:sub(1, 117) .. '...') or trimmed
    end
  end
  return nil
end

local function parse_stdout(stdout)
  if type(stdout) ~= 'string' or stdout:match('^%s*$') then
    return nil, 'no JSON result on stdout (empty output)'
  end
  local decoded = M.extract_json(stdout)
  if decoded then
    return decoded, nil
  end
  return nil,
    string.format(
      'stdout was not JSON (%d bytes): %s — is `bin` the s2s binary?',
      #stdout,
      tostring(first_line(stdout))
    )
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
      argv = argv,
      stdout = stdout,
      stderr = stderr,
      json = json,
      parse_error = parse_error,
    })
  end)

  if not ok then
    finish({
      code = -1,
      signal = nil,
      argv = argv,
      stdout = '',
      stderr = '',
      json = nil,
      parse_error = 'could not start the binary — check `bin` in setup()',
    })
  end
end

return M
