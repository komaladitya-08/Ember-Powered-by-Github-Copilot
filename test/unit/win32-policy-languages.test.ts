/**
 * Windows' "never run programs" rules in every Windows display language (review #109): the Run dialog (title and its
 * Open box), File Explorer's address box, and Explorer's Open and Run as commands are known in the languages Windows
 * ships, not only English, German, French, Spanish, Italian, Portuguese, Dutch, Japanese, Chinese and Korean; and the
 * address box showing a path is known by that shape whatever its language. The strings are Windows' own as far as
 * known here: a localized Windows runner checks them for real.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";

const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ explorer: "act" }), os: "win32", keys: KEYS.win32, ownPid: 1, rateLimit: 1e6 });
const decide = (r: Partial<ActionRequest>) => e.decide({ taskId: "t", kind: "click", app: "explorer", window: "Documents", windowId: { pid: 77, role: "frame" }, ...r });

/** [language, the Run dialog's title, its Open box, File Explorer's address box, Run as administrator]. */
const WINDOWS: [string, string, string, string, string][] = [
  ["ar", "تشغيل", "فتح:", "العنوان", "تشغيل كمسؤول"],
  ["bg", "Изпълнение", "Отваряне:", "Адрес", "Изпълнение като администратор"],
  ["cs", "Spustit", "Otevřít:", "Adresa", "Spustit jako správce"],
  ["da", "Kør", "Åbn:", "Adresse", "Kør som administrator"],
  ["el", "Εκτέλεση", "Άνοιγμα:", "Διεύθυνση", "Εκτέλεση ως διαχειριστής"],
  ["et", "Käivitamine", "Ava:", "Aadress", "Käivita administraatorina"],
  ["fi", "Suorita", "Avaa:", "Osoite", "Suorita järjestelmänvalvojana"],
  ["he", "הפעלה", "פתח:", "כתובת", "הפעל כמנהל מערכת"],
  ["hr", "Pokretanje", "Otvori:", "Adresa", "Pokreni kao administrator"],
  ["hu", "Futtatás", "Megnyitás:", "Cím", "Futtatás rendszergazdaként"],
  ["lt", "Vykdyti", "Atidaryti:", "Adresas", "Vykdyti kaip administratoriui"],
  ["lv", "Palaišana", "Atvērt:", "Adrese", "Palaist kā administratoram"],
  ["nb", "Kjør", "Åpne:", "Adresse", "Kjør som administrator"],
  ["pl", "Uruchamianie", "Otwórz:", "Adres", "Uruchom jako administrator"],
  ["ro", "Executare", "Deschidere:", "Adresă", "Executare ca administrator"],
  ["ru", "Выполнить", "Открыть:", "Адрес", "Запуск от имени администратора"],
  ["sk", "Spustiť", "Otvoriť:", "Adresa", "Spustiť ako správca"],
  ["sl", "Zaženi", "Odpri:", "Naslov", "Zaženi kot skrbnik"],
  ["sv", "Kör", "Öppna:", "Adress", "Kör som administratör"],
  ["th", "เรียกใช้", "เปิด:", "ที่อยู่", "เรียกใช้ในฐานะผู้ดูแลระบบ"],
  ["tr", "Çalıştır", "Aç:", "Adres", "Yönetici olarak çalıştır"],
  ["uk", "Виконати", "Відкрити:", "Адреса", "Запуск від імені адміністратора"],
  ["ja", "ファイル名を指定して実行", "名前(O):", "アドレス", "管理者として実行"],
  ["zh-TW", "執行", "開啟(O):", "位址", "以系統管理員身分執行"],
];

describe("Windows' run-program rules in every display language", () => {
  it.each(WINDOWS)("%s: the Run dialog is only read, and nothing is typed into its Open box", (_lang, title, box) => {
    const run = { window: title, windowId: { pid: 77, role: "dialog" } };
    expect(decide({ ...run, element: { role: "push button", name: "OK" } }).verdict).toBe("deny");
    expect(decide({ ...run, kind: "text", element: { role: "combo box", name: box }, value: "cmd", mode: "replace", currentText: "" }).verdict).toBe("deny");
    // The box alone refuses any text too, whatever the window says it is.
    expect(decide({ kind: "text", element: { role: "combo box", name: box }, value: "notepad", mode: "replace", currentText: "" }).verdict).toBe("deny");
    expect(decide({ ...run, kind: "read" }).verdict).toBe("allow");
  });

  it.each(WINDOWS)("%s: File Explorer's address box refuses a program's name and takes a folder's path", (_lang, _title, _box, address) => {
    const type = (value: string, name = address) => decide({ kind: "text", element: { role: "edit", name }, value, mode: "replace", currentText: "" });
    expect(type("cmd").verdict).toBe("deny");
    expect(type("powershell -c x").verdict).toBe("deny");
    expect(type("C:\\Users\\ada\\Documents").verdict).toBe("allow");
    expect(type("cmd", `${address}: C:\\Users\\ada`).verdict).toBe("deny");
  });

  it.each(WINDOWS)("%s: Explorer's Run as administrator command is never used", (_lang, _title, _box, _address, admin) => {
    expect(decide({ element: { role: "menu item", name: admin } }).verdict).toBe("deny");
  });

  it("knows the address box showing a path by its shape, whatever its language", () => {
    const type = (name: string, value = "cmd") => decide({ kind: "text", element: { role: "edit", name }, value, mode: "replace", currentText: "" });
    for (const name of ["Adreça: C:\\Users\\ada", "Helbidea: \\\\server\\share", "Địa chỉ: %USERPROFILE%\\Downloads", "Alamat: C:\\"]) expect(type(name).verdict, name).toBe("deny");
    expect(type("Alamat: C:\\", "C:\\Users\\ada\\Music").verdict).toBe("allow");
  });

  it("leaves other fields and commands as they were", () => {
    const type = (name: string, value = "cmd") => decide({ kind: "text", element: { role: "edit", name }, value, mode: "replace", currentText: "" });
    for (const name of ["Search Documents", "Address and search bar", "File name:", "Open with"]) expect(type(name).verdict, name).not.toBe("deny");
    for (const name of ["Open file location", "Properties", "Rename"]) expect(decide({ element: { role: "menu item", name } }).verdict, name).not.toBe("deny");
    expect(decide({ window: "Kör", windowId: { pid: 77, role: "frame" }, element: { role: "push button", name: "OK" } }).verdict).not.toBe("deny");
  });

  it("knows Explorer's other Open and Run as commands in the newly added languages", () => {
    for (const name of ["Открыть", "Открыть с помощью", "Запуск от имени другого пользователя", "Otwórz", "Otwórz za pomocą", "Aç", "Birlikte aç",
      "Öppna med", "Åbn med", "Avaa", "Otevřít", "Megnyitás", "Άνοιγμα με", "Відкрити", "פתח באמצעות", "فتح باستخدام"]) {
      expect(decide({ element: { role: "menu item", name } }).verdict, name).toBe("deny");
    }
  });
});
