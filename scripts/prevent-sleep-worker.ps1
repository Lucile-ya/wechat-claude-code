# Keeps Windows awake while bridge daemon runs (like macOS caffeinate).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SleepUtil {
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001
$ES_AWAYMODE_REQUIRED = 0x00000040
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED

while ($true) {
  [void][SleepUtil]::SetThreadExecutionState($flags)
  Start-Sleep -Seconds 30
}
