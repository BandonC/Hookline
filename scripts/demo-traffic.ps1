# Drives the public demo through the real API, so the dashboard shows genuine
# delivery state instead of inserted rows. Safe to re-run: it adds events and
# wipes nothing.
#
#   ep "Payments webhook"  flaky receiver: retries, some then succeed, some dead-letter
#   ep "CRM contact sync"  ordered, always-failing receiver: trips the circuit breaker
#
# Going through the API (rather than scripts/seed-demo.sql) keeps credentials
# encrypted at rest. The busy states fade on their own: Payments settles in a few
# minutes, and the breaker stays open for -BreakerMinutes at a time while its
# events use up their remaining attempts.
#
# Usage (asks for your ADMIN_API_KEY without showing or storing it):
#   pwsh ./scripts/demo-traffic.ps1
#   pwsh ./scripts/demo-traffic.ps1 -BreakerMinutes 60

param(
  [string]$ApiBase = "https://api.bandonc.com",
  [ValidateRange(1, 60)]
  [int]$BreakerMinutes = 30,
  [string]$PaymentsTenant = "ten_acme",
  [string]$CrmTenant = "ten_globex"
)

$ErrorActionPreference = "Stop"

$adminKey = $env:HOOKLINE_ADMIN_KEY
if (-not $adminKey) {
  $secure = Read-Host "Admin API key" -AsSecureString
  $adminKey = ConvertFrom-SecureString $secure -AsPlainText
}

function Invoke-Api([string]$Method, [string]$Path, [string]$Token, $Body) {
  $params = @{
    Method  = $Method
    Uri     = "$ApiBase$Path"
    Headers = @{ Authorization = "Bearer $Token" }
  }
  if ($null -ne $Body) {
    $params.Body = $Body | ConvertTo-Json -Depth 5 -Compress
    $params.ContentType = "application/json"
  }
  Invoke-RestMethod @params
}

# Matched by description because the API generates endpoint ids. Re-applying the
# config on every run also resets the breaker, so each run trips it afresh.
function Get-DemoEndpoint([string]$Description, [string]$Tenant, [string]$Url, $Config) {
  $existing = (Invoke-Api GET "/v1/endpoints" $adminKey $null).endpoints |
    Where-Object { $_.description -eq $Description } |
    Select-Object -First 1

  if ($existing) {
    Write-Host "found   $Description ($($existing.id))"
    $id = $existing.id
  } else {
    $created = Invoke-Api POST "/v1/endpoints" $adminKey @{
      url = $Url; description = $Description; tenant_id = $Tenant
    }
    Write-Host "created $Description ($($created.id))"
    $id = $created.id
  }

  Invoke-Api PATCH "/v1/endpoints/$id" $adminKey $Config | Out-Null

  # Ingest keys are only returned at creation or rotation, and this script is the
  # endpoint's only publisher, so a fresh key each run costs nothing.
  $ingestKey = (Invoke-Api POST "/v1/endpoints/$id/rotate-ingest-key" $adminKey $null).ingest_key
  @{ Id = $id; IngestKey = $ingestKey }
}

function Send-Event($Endpoint, $Payload, [string]$OrderingKey) {
  $body = @{ endpoint_id = $Endpoint.Id; payload = $Payload }
  if ($OrderingKey) { $body.ordering_key = $OrderingKey }
  Invoke-Api POST "/v1/events" $Endpoint.IngestKey $body | Out-Null
}

$payments = Get-DemoEndpoint "Payments webhook" $PaymentsTenant `
  "https://httpbin.org/status/200,503,503" `
  @{ rate_limit_rps = 5; rate_limit_burst = 10 }

$crm = Get-DemoEndpoint "CRM contact sync (ordered per contact)" $CrmTenant `
  "https://httpbin.org/status/500" `
  @{
    ordered                 = $true
    circuit_breaker_enabled = $true
    breaker_open_sec        = $BreakerMinutes * 60
    breaker_threshold_pct   = 50
  }

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

foreach ($n in 1..4) {
  Send-Event $payments @{ type = "payment.succeeded"; id = "$stamp-$n" } $null
}

# The breaker needs 5 attempts inside its 30s window, so these go out together on
# distinct keys. contact-881 appears twice so one event queues behind another.
foreach ($key in "contact-15", "contact-17", "contact-22", "contact-30", "contact-44", "contact-58", "contact-881", "contact-881") {
  Send-Event $crm @{ type = "contact.updated"; contact = $key; id = $stamp } $key
}

Write-Host "sent 4 payment events and 8 CRM events"
Write-Host "the CRM breaker should open within about a minute: https://hookline.bandonc.com"
