#!/usr/bin/env python3
"""旺季單量模擬（規格第 14 節）：產生假的 BPM 物流表（24 欄，跟真的一樣）

用法：py -3 gen_logistics.py <單數> <輸出.xlsx> [出廠日 YYYY/MM/DD]
- 每單 1～4 個品項（平均約 1.8）
- 物流方式比例：7-11 取貨 30%、全家 取貨 10%、黑貓宅配 35%、宅配（自建單，走新竹）25%
- 收件人、電話、地址都是假的；商品編號用心茶真的料號格式
- 固定亂數種子：同樣的單數每次產生一樣的檔案
"""
import sys, random, openpyxl

H = ['單號', '訂單日期', '收件人', '收件人電話', '收件人地址', '收件人Email', '付款方式', '物流方式', '訂單備註', '訂單金額', '發票抬頭', '統一編號',
     '商品編號', '商品名稱', '數量', '小計', '單位', '明細備註', '寄件人', '寄件人電話', '心茶訂單key值', '最早可出廠日', '生產廠商', '訂單狀態']
SHIP = [('7-11 取貨', 30), ('全家 取貨', 10), ('黑貓宅配 (常溫) - 本島運送 - 商品含茶點建議選用', 35), ('宅配', 25)]
SKUS = [('AA00181', '【新年禮盒2025】三層特選禮盒_茶包15入x茶點3入'), ('AA00182', '【新年禮盒2025】三層特選禮盒_茶包30入'),
        ('B020001', '【主題系列】綜合茶包 4入組'), ('A020011', '【蜜香風味選】茶主題綜合茶包4入'), ('AA00376', '【冬季限定】暖心茶禮盒'),
        ('AA00277', '【經典】烏龍茶包 10入'), ('AA00278', '【經典】紅茶茶包 10入'), ('AA00289', '【茶點】鳳梨酥 6入'),
        ('AA00291', '【茶點】牛軋糖 12入'), ('AA00338', '【禮盒】四季茶語'), ('AA00366', '【禮盒】品茗雙享'), ('AA00374', '【單品】高山青茶 75g')]
SURN = '陳林黃張李王吳劉蔡楊許鄭謝郭洪曾'
CITY = ['台北市大安區', '新北市板橋區', '桃園市中壢區', '台中市西屯區', '台南市東區', '高雄市苓雅區', '新竹市東區', '基隆市信義區']


def main(n, out, ship_date='2026/11/30'):
    rnd = random.Random(20261124 + n)
    ws_rows = [H]
    ships = [s for s, w in SHIP for _ in range(w)]
    for i in range(n):
        no = '#2026112%d%011d' % (rnd.randint(0, 3), 10000000 + i)
        ship = ships[i % len(ships)] if n >= len(ships) else rnd.choice(ships)
        name = rnd.choice(SURN) + '測試' + str(i)
        phone = '09%08d' % rnd.randint(0, 99999999)
        addr = ('門市名稱：測試門市%d, 門市代碼：%06d' % (i, rnd.randint(100000, 999999))) if '取貨' in ship else rnd.choice(CITY) + '測試路%d號' % (i + 1)
        k = rnd.choices([1, 2, 3, 4], weights=[50, 30, 12, 8])[0]
        for j, (sku, pname) in enumerate(rnd.sample(SKUS, k), 1):
            ws_rows.append([no, '2026/11/23', name, phone, addr, None, 'Apple Pay', ship, None, str(rnd.randint(500, 5000)) if j == 1 else '0',
                            None, None, sku, pname, str(rnd.randint(1, 3)), None, None, None, '心茶', '03-8900198', '%s-%d' % (no, j), ship_date, '俬儲空間', '新增'])
    wb = openpyxl.Workbook()
    ws = wb.active
    for r in ws_rows:
        ws.append(r)
    wb.save(out)
    by = {}
    for r in ws_rows[1:]:
        by.setdefault(r[7], set()).add(r[0])
    print('RESULT_JSON: {"orders": %d, "lines": %d, "by": {%s}}' % (n, len(ws_rows) - 1, ', '.join('"%s": %d' % (k[:6], len(v)) for k, v in by.items())))


if __name__ == '__main__':
    main(int(sys.argv[1]), sys.argv[2], *(sys.argv[3:4]))
