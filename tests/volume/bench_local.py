#!/usr/bin/env python3
"""旺季單量模擬（規格第 14 節）：本機 Python 步驟的耗時

用法：py -3 -X utf8 bench_local.py <心茶自動化資料夾> <範本託運單資料夾> <暫存輸出資料夾> [單數 ...]
只在 <暫存輸出資料夾> 裡讀寫，不碰 E:\\USER_不能刪\\Downloads、不連網、不送印。
量的步驟（都是正式流程用的同一支程式，呼叫方式跟 b2c-start.js／b2c-ship.js 一樣）：
  整單（含 SG出、SG採購單 上傳檔產生）  xintea_zhengdan.py <物流表> 1
  拆可出貨／無庫存                     xintea_sg_split.py <SG 匯入結果>（假結果：SG出 檔加 AT 欄「結果」，9 成成功）
  託運單裁切                           xintea_label_cut.py <7-11、全家 託運單 PDF>（用真的 7-11 託運單頁面複製成對應頁數）
"""
import os, sys, json, math, time, glob, shutil, subprocess, random
import openpyxl
from pypdf import PdfReader, PdfWriter

SRC, TPL, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SIZES = [int(x) for x in sys.argv[4:]] or [6, 300, 600, 900]
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1', XT_DOWNLOADS=OUT)


def run(args, cwd):
    t = time.perf_counter()
    p = subprocess.run(['py', '-3', '-X', 'utf8'] + args, cwd=cwd, env=ENV, capture_output=True, text=True, encoding='utf-8', errors='replace')
    dt = time.perf_counter() - t
    res = None
    for line in p.stdout.splitlines():
        if line.startswith('RESULT_JSON: '):
            res = json.loads(line[13:])
    return dt, p.returncode, res, (p.stderr or '')[-400:], p.stdout[-400:]


def fake_sg_result(sgout, dst, rnd):
    """SG 匯入結果 = SG出 檔＋AT 欄（第 46 欄）結果；同一單一起成功或失敗，9 成成功"""
    wb = openpyxl.load_workbook(sgout)
    ws = wb.worksheets[0]
    ws.title = 'Worksheet'
    ws.cell(1, 46, '結果')
    fate = {}
    for r in range(2, ws.max_row + 1):
        oid = ws.cell(r, 1).value
        if oid in (None, ''):
            continue
        fate.setdefault(oid, '成功' if rnd.random() < 0.9 else '失敗')
        ws.cell(r, 46, fate[oid])
    wb.save(dst)
    return len(fate)


def label_pdf(tpl, dst, pages):
    rd = PdfReader(tpl)
    w = PdfWriter()
    for i in range(pages):
        w.add_page(rd.pages[i % len(rd.pages)])
    with open(dst, 'wb') as f:
        w.write(f)


def main():
    rows = []
    tpl711 = next(iter(glob.glob(os.path.join(TPL, '*711 託運單.pdf'))), None)
    for n in SIZES:
        d = os.path.join(OUT, f'n{n}', '心茶1130')
        shutil.rmtree(os.path.dirname(d), ignore_errors=True)
        os.makedirs(d)
        logi = os.path.join(d, '物流表B2C_20261130_090000.xlsx')
        _, _, g, err, _ = run([os.path.join(HERE, 'gen_logistics.py'), str(n), logi], d)
        if not g:
            print('產生假資料失敗', err); sys.exit(1)
        r = {'orders': n, 'lines': g['lines'], 'by': g['by'], 'xlsx_kb': round(os.path.getsize(logi) / 1024)}

        dt, rc, z, err, _ = run([os.path.join(SRC, 'xintea_zhengdan.py'), logi, '1'], SRC)
        r['整單_s'] = round(dt, 2); r['整單_ok'] = rc == 0 and bool(z)
        if not r['整單_ok']:
            r['整單_err'] = err
        else:
            r['自建宅配'] = z.get('宅配(自建單)')
            sgout = [p for p in z['outputs'] if 'SG出-' in p][0]
            r['SG出_kb'] = round(os.path.getsize(sgout) / 1024)
            res = os.path.join(d, 'order_import_result_sim.xlsx')
            fake_sg_result(sgout, res, random.Random(n))
            dt, rc, _, err, so = run(['-c', 'import sys,json; sys.path.insert(0, sys.argv[1]); import xintea_sg_split as m; print("RESULT_JSON: " + json.dumps(m.run(sys.argv[2], "1130"), ensure_ascii=False))', SRC, res], SRC)
            r['拆檔_s'] = round(dt, 2); r['拆檔_ok'] = rc == 0
            if rc:
                r['拆檔_err'] = err or so

        if tpl711:
            n711 = sum(v for k, v in g['by'].items() if k.startswith('7-11'))
            nfm = sum(v for k, v in g['by'].items() if k.startswith('全家'))
            pages = math.ceil(n711 / 4) + math.ceil(nfm / 4)
            label_pdf(tpl711, os.path.join(d, '20261130_官網訂單_711 託運單.pdf'), math.ceil(n711 / 4))
            label_pdf(tpl711, os.path.join(d, '20261130_官網訂單_全家 託運單.pdf'), max(1, math.ceil(nfm / 4)))
            dt, rc, _, err, so = run([os.path.join(SRC, 'xintea_label_cut.py'), os.path.join(d, '20261130_官網訂單_711 託運單.pdf'), os.path.join(d, '20261130_官網訂單_全家 託運單.pdf')], SRC)
            r['裁切_pages'] = pages; r['裁切_s'] = round(dt, 2); r['裁切_ok'] = rc == 0
            if rc:
                r['裁切_err'] = (err or so)[-300:]
        rows.append(r)
        print(json.dumps(r, ensure_ascii=False), flush=True)
    with open(os.path.join(OUT, 'bench_local.json'), 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


main()
