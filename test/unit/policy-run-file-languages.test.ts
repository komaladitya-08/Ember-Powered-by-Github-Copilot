/**
 * Running programs from the file manager on RHEL in the other languages of RISKY_WORDS (review #114): Nautilus's
 * "run or display" dialog's Run (and Run in Terminal), and Properties' "Allow executing file as program" check box,
 * are refused as they are in English, German, French, Spanish, Italian and Portuguese. The strings are Nautilus 3.28's
 * as its translations word them (accelerator underscores dropped, as the screen reader drops them); a localized RHEL
 * desktop checks them for real.
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";

interface Words { lang: string; exec: string[]; term: string; run: string; display: string; ask: string; sure: string }
const NAUTILUS: Words[] = [
  { lang: "nl", exec: ["Uitvoeren van bestand als programma toestaan", "Toestaan dit bestand als programma uit te voeren"], term: "In terminal uitvoeren", run: "Uitvoeren", display: "Tonen", ask: "Wilt u ‘invoice’ uitvoeren, of de inhoud ervan tonen?", sure: "‘invoice’ is een uitvoerbaar tekstbestand." },
  { lang: "pl", exec: ["Zezwolenie na wykonywanie pliku jako programu", "Zezwalaj na wykonywanie pliku jako programu"], term: "Uruchom w terminalu", run: "Uruchom", display: "Wyświetl", ask: "Uruchomić „invoice”, czy wyświetlić jego zawartość?", sure: "„invoice” jest wykonywalnym plikiem tekstowym." },
  { lang: "ru", exec: ["Разрешить выполнение файла как программы"], term: "Запустить в терминале", run: "Запустить", display: "Показать", ask: "Запустить «invoice» или показать его содержимое?", sure: "«invoice» — исполняемый текстовый файл." },
  { lang: "sv", exec: ["Tillåt körning av fil som program", "Tillåt att köra fil som program"], term: "Kör i terminal", run: "Kör", display: "Visa", ask: "Vill du köra ”invoice”, eller visa dess innehåll?", sure: "”invoice” är en körbar textfil." },
  { lang: "da", exec: ["Tillad kørsel af fil som program"], term: "Kør i terminal", run: "Kør", display: "Vis", ask: "Ønsker du at køre “invoice” eller vise dens indhold?", sure: "“invoice” er en kørbar tekstfil." },
  { lang: "nb", exec: ["Tillat kjøring av fil som program"], term: "Kjør i terminal", run: "Kjør", display: "Vis", ask: "Vil du kjøre «invoice», eller vise innholdet?", sure: "«invoice» er en kjørbar tekstfil." },
  { lang: "fi", exec: ["Salli tiedoston suorittaminen ohjelmana"], term: "Suorita päätteessä", run: "Suorita", display: "Näytä", ask: "Haluatko suorittaa tiedoston “invoice” vai näyttää sen sisällön?", sure: "“invoice” on suoritettava tekstitiedosto." },
  { lang: "cs", exec: ["Povolit spouštění souboru jako programu"], term: "Spustit v terminálu", run: "Spustit", display: "Zobrazit", ask: "Chcete spustit „invoice“, nebo zobrazit jeho obsah?", sure: "„invoice“ je spustitelný textový soubor." },
  { lang: "tr", exec: ["Dosyanın program olarak çalıştırılmasına izin ver"], term: "Uçbirimde çalıştır", run: "Çalıştır", display: "Görüntüle", ask: "“invoice” dosyasını çalıştırmak mı yoksa içeriğini görüntülemek mi istiyorsunuz?", sure: "“invoice” çalıştırılabilir bir metin dosyasıdır." },
  { lang: "ja", exec: ["プログラムとして実行できる", "プログラムとして実行可能にする"], term: "端末で実行する", run: "実行する", display: "表示する", ask: "“invoice” を実行しますか？ それとも内容を表示しますか？", sure: "“invoice” は実行可能なテキストファイルです。" },
  { lang: "zh_CN", exec: ["允许作为程序执行文件", "允许以程序执行文件"], term: "在终端中运行", run: "运行", display: "显示", ask: "您想要运行“invoice”还是显示它的内容？", sure: "“invoice”是可执行的文本文件。" },
  { lang: "zh_TW", exec: ["允許以程式執行檔案"], term: "在終端機中執行", run: "執行", display: "顯示", ask: "您要執行「invoice」，或是顯示它的內容？", sure: "「invoice」是可執行的文字檔。" },
  { lang: "ko", exec: ["파일을 프로그램으로 실행 허용", "파일을 프로그램으로 실행하도록 허용"], term: "터미널에서 실행", run: "실행", display: "표시", ask: "“invoice”을(를) 실행하시겠습니까, 아니면 내용을 표시하시겠습니까?", sure: "“invoice”은(는) 실행 가능한 텍스트 파일입니다." },
];

const granted = new PolicyEngine({ neverLook: () => [], grants: () => ({ nautilus: "act" }), rateLimit: 1e6 });
const decide = (o: Partial<ActionRequest>, onDesk = false) =>
  granted.decide({ taskId: "n", kind: "click", app: "nautilus", window: "Downloads", goal: "tidy up my downloads", onDesk, ...o });

describe("running a file from Nautilus in the other languages", () => {
  it.each(NAUTILUS)("$lang: making a file executable or running it is refused, in a granted Files and on the desk", t => {
    for (const onDesk of [false, true]) {
      for (const name of t.exec) {
        expect(decide({ kind: "toggle", window: "invoice Properties", element: { role: "check box", name }, value: "on" }, onDesk).verdict, name).toBe("deny");
      }
      for (const dialog of [{ name: "", text: t.ask }, { name: "", text: t.sure }, { name: t.ask, text: t.sure }]) {
        expect(decide({ element: { role: "push button", name: t.run }, dialog }, onDesk).verdict, `${t.run} / ${dialog.text}`).toBe("deny");
        expect(decide({ element: { role: "push button", name: t.term }, dialog }, onDesk).verdict, t.term).toBe("deny");
        // "Display" in the same dialog only shows the file.
        expect(decide({ element: { role: "push button", name: t.display }, dialog }, onDesk).verdict, t.display).not.toBe("deny");
      }
    }
  });

  it.each(NAUTILUS)("$lang: a Run button anywhere else is judged as before (not refused)", t => {
    expect(decide({ element: { role: "push button", name: t.run } }).verdict).not.toBe("deny");
    expect(decide({ element: { role: "push button", name: t.display }, dialog: { name: "", text: t.sure } }).verdict).not.toBe("deny");
  });
});
