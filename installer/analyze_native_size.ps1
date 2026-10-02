# Analyze final linked PE bytes and MSVC linker maps. No changes to the binaries.
param(
    [string]$InputDirectory = '',
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $InputDirectory) { $InputDirectory = Join-Path $root '.codex/size-analysis/production' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root '.codex/size-analysis/report' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
public class SizeSection {
    public string Name; public int Index; public long RawBytes, VirtualBytes, Rva, RawOffset;
    public bool Code;
}
public class SizeSymbol {
    public long Rva, Bytes; public string Name, Owner, Category; public string[] Aliases;
}
public class SizeGroup { public string Name; public long Bytes; public int Entries; }
public class SizeImport { public string Dll; public string[] Functions; }
public class NativeSizeResult {
    public string Binary, Map; public long FileBytes, CertificateBytes, HeaderBytes;
    public SizeSection[] Sections; public SizeSymbol[] Symbols;
    public SizeGroup[] Categories, Owners, StlFamilies;
    public SizeImport[] Imports;
    public long CodeVirtualBytes, CodeAttributedBytes, CodeUnattributedBytes;
}
public static class NativeSize {
    [DllImport("dbghelp.dll", CharSet=CharSet.Ansi)]
    private static extern uint UnDecorateSymbolName(string name, StringBuilder output, uint length, uint flags);
    static string Decode(string name) {
        var buffer = new StringBuilder(8192);
        return UnDecorateSymbolName(name, buffer, (uint)buffer.Capacity, 0x1000) == 0 ? name : buffer.ToString();
    }
    public static string OwnerCategory(string owner) {
        string n = owner.ToLowerInvariant();
        if (n.Contains("libucrt:") || n.Contains("libcmt:") || n.Contains("libvcruntime:")) return "Static CRT / C++ exception runtime";
        if (n.Contains("libcpmt:")) return "Static C++ standard library";
        if (n.Contains("msvcprt:") || n.Contains("msvcrt:") || n.Contains("ucrt:") || n.Contains("vcruntime:")) return "MSVC runtime import/support code";
        if (n.Contains("pfc") || n.Contains("foobar2000_sdk") || n.Contains("libppui") || n.Contains("foobar2000_helpers") || n.Contains("shared-x64")) return "foobar SDK / PFC / PPUI";
        if (n.Contains(":")) return "OS / external import thunks";
        return "Application code (includes inlined templates)";
    }
    public static string SymbolCategory(string owner, string name) {
        string category = OwnerCategory(owner);
        if (category.StartsWith("Application") && (name.StartsWith("std::") || name.StartsWith("`std::"))) return "Named STL template functions";
        return category;
    }
    static string Family(string name) {
        if (name.Contains("shared_ptr") || name.Contains("_Ref_count") || name.Contains("unique_ptr")) return "smart pointers";
        if (name.Contains("function<") || name.Contains("_Func")) return "std::function / callable erasure";
        if (name.Contains("_Tree") || name.Contains("map<") || name.Contains("set<")) return "ordered maps / sets";
        if (name.Contains("vector<") || name.Contains("_Vector")) return "vectors";
        if (name.Contains("basic_string") || name.Contains("char_traits")) return "strings";
        return "other STL templates";
    }
    static string Cstr(byte[] b, int at) {
        int end = at; while (end < b.Length && b[end] != 0) ++end;
        return Encoding.ASCII.GetString(b, at, end-at);
    }
    static int FileOffset(SizeSection[] sections, long rva) {
        foreach (var s in sections) if (rva >= s.Rva && rva < s.Rva + Math.Max(s.RawBytes, s.VirtualBytes)) return (int)(s.RawOffset+rva-s.Rva);
        throw new InvalidDataException("RVA outside PE sections: " + rva);
    }
    static SizeGroup[] Groups(IEnumerable<SizeSymbol> symbols, Func<SizeSymbol,string> key) {
        return symbols.GroupBy(key).Select(g => new SizeGroup { Name=g.Key, Bytes=g.Sum(x=>x.Bytes), Entries=g.Count() }).OrderByDescending(x=>x.Bytes).ToArray();
    }
    public static NativeSizeResult Analyze(string binary, string map) {
        byte[] b = File.ReadAllBytes(binary);
        int pe = BitConverter.ToInt32(b,60), optional=pe+24;
        string mapText=File.ReadAllText(map);
        var stamp=Regex.Match(mapText,@"Timestamp is ([0-9a-fA-F]+)");
        if(!stamp.Success || Convert.ToUInt32(stamp.Groups[1].Value,16)!=BitConverter.ToUInt32(b,pe+8))
            throw new InvalidDataException("Linker map does not match this binary's PE timestamp: " + binary);
        bool x64 = BitConverter.ToUInt16(b,optional)==0x20b;
        int directories=optional+(x64 ? 112 : 96);
        int table=optional+BitConverter.ToUInt16(b,pe+20), count=BitConverter.ToUInt16(b,pe+6);
        var sections = new List<SizeSection>();
        for(int i=0;i<count;++i) {
            int at=table+i*40;
            sections.Add(new SizeSection { Name=Encoding.ASCII.GetString(b,at,8).TrimEnd('\0'), Index=i+1,
                VirtualBytes=BitConverter.ToUInt32(b,at+8), Rva=BitConverter.ToUInt32(b,at+12),
                RawBytes=BitConverter.ToUInt32(b,at+16), RawOffset=BitConverter.ToUInt32(b,at+20),
                Code=(BitConverter.ToUInt32(b,at+36)&0x20000000)!=0 });
        }
        var sec=sections.ToArray();
        var rows=new List<SizeSymbol>();
        var rx=new Regex(@"^\s*([0-9a-fA-F]{4}):([0-9a-fA-F]{8})\s+(\S+)\s+([0-9a-fA-F]{8,16})\s+(.+?)\s*$");
        foreach(string line in File.ReadLines(map)) {
            var m=rx.Match(line); if(!m.Success) continue;
            int segment=Convert.ToInt32(m.Groups[1].Value,16);
            if(segment<1 || segment>sec.Length || !sec[segment-1].Code) continue;
            var tail=Regex.Replace(m.Groups[5].Value,@"^(?:[fi]\s+)+","");
            string name=Decode(m.Groups[3].Value);
            rows.Add(new SizeSymbol { Rva=sec[segment-1].Rva+Convert.ToInt64(m.Groups[2].Value,16), Name=name, Owner=tail, Category=SymbolCategory(tail,name) });
        }
        var symbols=new List<SizeSymbol>();
        foreach(var section in sec.Where(x=>x.Code)) {
            var groups=rows.Where(x=>x.Rva>=section.Rva && x.Rva<section.Rva+section.VirtualBytes).GroupBy(x=>x.Rva).OrderBy(x=>x.Key).ToArray();
            for(int i=0;i<groups.Length;++i) {
                var aliases=groups[i].ToArray();
                var categories=aliases.Select(x=>x.Category).Distinct().ToArray();
                var owners=aliases.Select(x=>x.Owner).Distinct().ToArray();
                var first=aliases[0];
                first.Bytes=(i+1<groups.Length ? groups[i+1].Key : section.Rva+section.VirtualBytes)-first.Rva;
                first.Aliases=aliases.Select(x=>x.Name).Distinct().ToArray();
                if(categories.Length>1) first.Category="Shared / folded across categories";
                if(owners.Length>1) first.Owner="Shared / folded across objects";
                symbols.Add(first);
            }
        }
        var imports=new List<SizeImport>();
        long importRva=BitConverter.ToUInt32(b,directories+8);
        if(importRva!=0) {
            int at=FileOffset(sec,importRva);
            for(;BitConverter.ToUInt32(b,at+12)!=0;at+=20) {
                string dll=Cstr(b,FileOffset(sec,BitConverter.ToUInt32(b,at+12)));
                long thunk=BitConverter.ToUInt32(b,at); if(thunk==0) thunk=BitConverter.ToUInt32(b,at+16);
                int pointer=FileOffset(sec,thunk); var functions=new List<string>();
                for(;;pointer+=x64?8:4) {
                    ulong value=x64 ? BitConverter.ToUInt64(b,pointer) : BitConverter.ToUInt32(b,pointer);
                    if(value==0) break;
                    if((value & (x64 ? 0x8000000000000000UL : 0x80000000UL))!=0) functions.Add("ordinal " + (value&0xffff));
                    else functions.Add(Cstr(b,FileOffset(sec,(long)value)+2));
                }
                imports.Add(new SizeImport { Dll=dll, Functions=functions.ToArray() });
            }
        }
        long code=sec.Where(x=>x.Code).Sum(x=>x.VirtualBytes), attributed=symbols.Sum(x=>x.Bytes);
        return new NativeSizeResult { Binary=binary,Map=map,FileBytes=b.Length,HeaderBytes=BitConverter.ToUInt32(b,optional+60),
            CertificateBytes=BitConverter.ToUInt32(b,directories+4*8+4),Sections=sec,Symbols=symbols.OrderByDescending(x=>x.Bytes).ToArray(),
            Categories=Groups(symbols,x=>x.Category), Owners=Groups(symbols,x=>x.Owner),
            StlFamilies=Groups(symbols.Where(x=>x.Category=="Named STL template functions"),x=>Family(x.Name)),
            Imports=imports.ToArray(),CodeVirtualBytes=code,CodeAttributedBytes=attributed,CodeUnattributedBytes=code-attributed };
    }
}
'@
$modules = @(
    @{ Name='Winamp'; Base='gen_24sevenfm_covers'; Extension='.dll'; Dia='winamp-dia.tsv' },
    @{ Name='DV'; Base='24sevenfm_covers'; Extension='.exe'; Dia='viewer-dia.tsv' },
    @{ Name='foobar2000'; Base='foo_24sevenfm_covers'; Extension='.dll'; Dia='foobar-dia.tsv' }
)
$results = @()
foreach ($module in $modules) {
    $binary = Join-Path $InputDirectory ($module.Base + $module.Extension)
    $map = Join-Path $InputDirectory ($module.Base + '.map')
    $analysis = [NativeSize]::Analyze($binary, $map)
    $analysis.Symbols | Select-Object Rva,Bytes,Category,Owner,Name,@{n='Aliases';e={$_.Aliases -join ' | '}} |
        Export-Csv -LiteralPath (Join-Path $OutputDirectory ($module.Base + '-symbols.csv')) -NoTypeInformation
    $analysis.Imports | ForEach-Object { $dll=$_.Dll; $_.Functions | ForEach-Object { [pscustomobject]@{Dll=$dll;Function=$_} } } |
        Export-Csv -LiteralPath (Join-Path $OutputDirectory ($module.Base + '-imports.csv')) -NoTypeInformation
    $results += [pscustomobject]@{ Module=$module.Name; Analysis=$analysis }
}
$results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'analysis.json')
$results | ForEach-Object {
    [pscustomobject]@{ Module=$_.Module; Bytes=$_.Analysis.FileBytes; Code=$_.Analysis.CodeVirtualBytes;
        Buckets=$_.Analysis.Categories; TopObjects=@($_.Analysis.Owners | Select-Object -First 12);
        Stl=$_.Analysis.StlFamilies; Largest=@($_.Analysis.Symbols | Select-Object -First 12 Bytes,Name,Owner) }
} | ConvertTo-Json -Depth 6
