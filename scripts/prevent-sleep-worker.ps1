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
# Must use [uint32] — PowerShell -bor on signed ints yields negative values.
$flags = [uint32]0x80000000 -bor [uint32]0x00000001 -bor [uint32]0x00000040

while ($true) {
  [void][SleepUtil]::SetThreadExecutionState([uint32]$flags)
  Start-Sleep -Seconds 30
}
