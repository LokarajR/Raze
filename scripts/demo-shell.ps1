# A shell with no ANTHROPIC_API_KEY, for walking the demo the way a judge will.
#
# Why this exists: the chat surface strips the key when it spawns Claude Code, so
# it works whether or not the key is present. That is convenient and it is also a
# blind spot — it means testing here can never tell you what happens on a machine
# that genuinely does not have one. This removes the variable from the session
# itself, so everything you run afterwards is honest.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-shell.ps1
#
# Nothing is changed permanently. Closing this shell restores nothing because
# nothing was altered outside it.

Write-Host ''
Write-Host '  Raze demo shell' -ForegroundColor Green
Write-Host ''

$userScope = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
$machineScope = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'Machine')

if ($env:ANTHROPIC_API_KEY) {
  Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
  Write-Host '  ANTHROPIC_API_KEY  removed from this shell' -ForegroundColor Yellow
} else {
  Write-Host '  ANTHROPIC_API_KEY  was not set' -ForegroundColor Green
}

if ($userScope -or $machineScope) {
  Write-Host ''
  Write-Host '  Note: it is still set permanently, so any OTHER terminal you open' -ForegroundColor Yellow
  Write-Host '  will still have it. To remove it everywhere:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '      [Environment]::SetEnvironmentVariable(''ANTHROPIC_API_KEY'', $null, ''User'')' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  Then close and reopen your terminal. Deleting the key itself is a' -ForegroundColor Yellow
  Write-Host '  separate step, at console.anthropic.com.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  Claude Code will now use your subscription login rather than an API key.'
Write-Host '  Everything in sections 1-4 of QUICKSTART works without either.'
Write-Host ''
Write-Host '  Verify with:   claude -p "reply with OK"'
Write-Host ''

Set-Location $PSScriptRoot\..
$host.UI.RawUI.WindowTitle = 'Raze demo shell (no API key)'
