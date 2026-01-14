'use client';

import { useEffect, useMemo, useState } from 'react';
import liff from '@line/liff';

import SectionCard from '../components/SectionCard';
import StarRating from '../components/StarRating';
import TextCounterTextarea from '../components/TextCounterTextarea';

const MIN_COMMENT_LENGTH = 30;

/**
 * JSの `.length` は絵文字など（サロゲートペア）でズレることがある。
 * DB側の `char_length()` と概ね揃えるため、コードポイント数で数える。
 * （これで「フロントOKなのにDBで30未満扱い」事故が減る）
 */
const charLen = (s: string) => Array.from(s).length;

// 学年（DB保存値：1..6 / その他=99）
const gradeOptions = [
  { label: '1年生', value: 1 },
  { label: '2年生', value: 2 },
  { label: '3年生', value: 3 },
  { label: '4年生', value: 4 },
  { label: '5年生', value: 5 },
  { label: '6年生', value: 6 },
  { label: 'その他', value: 99 },
] as const;

// 学期（DB保存値）
const termOptions = [
  { label: '前期', value: 's1' },
  { label: '後期', value: 's2' },
  { label: 'Q1', value: 'q1' },
  { label: 'Q2', value: 'q2' },
  { label: 'Q3', value: 'q3' },
  { label: 'Q4', value: 'q4' },
  { label: '通年', value: 'full' },
  { label: '集中', value: 'intensive' },
  { label: 'その他', value: 'other' },
] as const;

const requirementTypeOptions = [
  { label: '必修', value: 'required' },
  { label: '選択', value: 'elective' },
  { label: '不明', value: 'unknown' },
] as const;

// 4段階：成績（DB保存値：1..4）
const performanceOptions = [
  { label: '未評価', value: 1 },
  { label: '単位なし', value: 2 },
  { label: '単位あり（普通）', value: 3 },
  { label: '単位あり（高評価）', value: 4 },
] as const;

// 4段階：課題の難易度（DB保存値：1..4）
const assignmentDifficultyOptions = [
  { label: '無し', value: 1 },
  { label: '易', value: 2 },
  { label: '中', value: 3 },
  { label: '難', value: 4 },
] as const;

// 5段階評価（DB列名に合わせる）
const assessmentOptions = [
  { key: 'credit_ease', label: '単位取得の楽単度' },
  { key: 'class_difficulty', label: '内容の難しさ' },
  { key: 'assignment_load', label: '課題の多さ' },
  { key: 'attendance_strictness', label: '出席の厳しさ' },
  { key: 'satisfaction', label: '総合満足度' },
  { key: 'recommendation', label: 'おすすめ度' },
] as const;

type RatingKey = (typeof assessmentOptions)[number]['key'];

function buildAcademicYearOptions() {
  const now = new Date();
  const current = now.getFullYear();
  const start = 2020; // 必要なら変える
  const end = current + 1; // 来年度分まで
  const years: number[] = [];
  for (let y = end; y >= start; y--) years.push(y);
  return years;
}

const academicYearOptions = buildAcademicYearOptions();

// 小さな「必須」バッジ
const RequiredBadge = () => (
  <span className="mr-2 rounded-sm bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
    必須
  </span>
);

// チェックマークアイコン
const CheckIcon = () => (
  <svg
    className="ml-1.5 h-4 w-4 text-emerald-500"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

// スピナーアイコン
const SpinnerIcon = () => (
  <svg
    className="-ml-1 mr-3 h-5 w-5 animate-spin text-white"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    ></circle>
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    ></path>
  </svg>
);

export default function ReviewFormPage() {
  // 'filling' | 'submitting' | 'success'
  const [formStatus, setFormStatus] = useState<'filling' | 'submitting' | 'success'>('filling');
  const [submitError, setSubmitError] = useState<string>('');
  const [lastReviewId, setLastReviewId] = useState<string>('');

  // LIFFから取れるLINEの生userId（DBには保存しない）
  const [lineUserId, setLineUserId] = useState<string>('');
  const [liffError, setLiffError] = useState<string>('');

  /**
   * このシステムで使うユーザーID（users.id）
   * - 画面上の表示はこれに寄せる（デバッグや照合が楽）
   */
  const [systemUserId, setSystemUserId] = useState<string>('');
  const [systemUserError, setSystemUserError] = useState<string>('');

  // 単位数入力モード
  const [creditInputMode, setCreditInputMode] = useState<'preset' | 'manual'>('preset');
  const [presetCredits, setPresetCredits] = useState<number | null>(2); // デフォルト2単位

  const initialFormState = {
    university: '',
    faculty: '',
    department: '',
    gradeAtTake: 0,
    courseName: '',
    teacherNames: [''],
    academicYear: new Date().getFullYear(),
    term: '',
    manualCredits: '',
    requirementTypeAtTake: '',
    performanceSelf: 0,
    assignmentDifficulty4: 0,
    ratings: assessmentOptions.reduce(
      (acc, curr) => ({ ...acc, [curr.key]: 0 }),
      {} as Record<RatingKey, number>
    ),
    comment: '',
  };

  // フォーム本体
  const [form, setForm] = useState(initialFormState);

  // リアルタイムバリデーションの状態
  const [validationStatus, setValidationStatus] = useState({
    university: false,
    faculty: false,
    gradeAtTake: false,
    courseName: false,
    academicYear: true, // 初期値があるのでOK
    term: false,
    requirementTypeAtTake: false,
    performanceSelf: false,
    assignmentDifficulty4: false,
    ratings: false,
    comment: false,
    credits: true, // 任意なので常にOK
  });

  // ----------------------------
  // 1) LIFF init（本番） / ローカルはダミーID（開発）
  // ----------------------------
  useEffect(() => {
    let canceled = false;

    const init = async () => {
      try {
        // ローカル(PCブラウザ)ではLIFFが成立しないことが多いので、開発用IDを優先
        if (process.env.NODE_ENV === 'development') {
          const devId = process.env.NEXT_PUBLIC_DEV_LINE_USER_ID;
          if (devId && !canceled) {
            setLineUserId(devId);
            return;
          }
        }

        const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
        if (!liffId) throw new Error('NEXT_PUBLIC_LIFF_ID is not set');

        await liff.init({ liffId });

        if (!liff.isLoggedIn()) {
          // 未ログインならログインフローへ
          liff.login();
          return;
        }

        const profile = await liff.getProfile();
        if (!canceled) setLineUserId(profile.userId);
      } catch (e: any) {
        if (!canceled) setLiffError(e?.message ?? 'LIFF init failed');
      }
    };

    init();
    return () => {
      canceled = true;
    };
  }, []);

  // ----------------------------
  // 2) lineUserId → users.id を解決して表示用に保持する
  // ----------------------------
  useEffect(() => {
    let canceled = false;

    const resolveSystemUser = async () => {
      // lineUserIdが無いと解決できない
      if (!lineUserId) return;

      setSystemUserError('');
      setSystemUserId('');

      try {
        const res = await fetch('/api/users/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ line_user_id: lineUserId }),
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          const msg =
            typeof json?.error === 'string'
              ? json.error
              : json?.error?.message
                ? json.error.message
                : `ユーザーID解決に失敗（HTTP ${res.status}）`;
          throw new Error(msg);
        }

        if (!canceled) setSystemUserId(String(json.user_id ?? ''));
      } catch (e: any) {
        if (!canceled) setSystemUserError(e?.message ?? 'ユーザーID解決でエラーが発生しました');
      }
    };

    resolveSystemUser();

    return () => {
      canceled = true;
    };
  }, [lineUserId]);

  // ----------------------------
  // 3) systemUserId（users.id）が取れたら、所属を取ってフォームに事前入力する
  // ----------------------------
  useEffect(() => {
    let canceled = false;
  
    const prefillAffiliation = async () => {
      if (!systemUserId) return;
  
      try {
        const res = await fetch('/api/user-affiliations/latest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: systemUserId }),
        });
  
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof json?.error === 'string'
              ? json.error
              : json?.error?.message
                ? json.error.message
                : `所属の取得に失敗（HTTP ${res.status}）`;
          throw new Error(msg);
        }
  
        const aff = json?.affiliation;
        if (!aff) return;
  
        // ユーザーが既に入力してたら上書きしない（体験を壊さない）
        if (canceled) return;
        setForm((prev) => {
          const universityEmpty = prev.university.trim().length === 0;
          const facultyEmpty = prev.faculty.trim().length === 0;
          const departmentEmpty = prev.department.trim().length === 0;
  
          return {
            ...prev,
            university: universityEmpty ? String(aff.university_name ?? '') : prev.university,
            faculty: facultyEmpty ? String(aff.faculty ?? '') : prev.faculty,
            department: departmentEmpty ? String(aff.department ?? '') : prev.department,
          };
        });
      } catch (e) {
        // ここはフォーム利用自体を止めるほどではないので、静かにログだけ
        console.warn('[prefill affiliation] failed:', e);
      }
    };
  
    prefillAffiliation();
  
    return () => {
      canceled = true;
    };
  }, [systemUserId]);

  // ----------------------------
  // フォーム操作系ヘルパ
  // ----------------------------
  const handleTextChange = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleNumberChange = (field: keyof typeof form, value: number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateRating = (key: RatingKey, value: number) => {
    setForm((prev) => ({ ...prev, ratings: { ...prev.ratings, [key]: value } }));
  };

  const updateTeacherName = (index: number, value: string) => {
    setForm((prev) => {
      const next = [...prev.teacherNames];
      next[index] = value;
      return { ...prev, teacherNames: next };
    });
  };

  const addTeacher = () => {
    setForm((prev) => {
      if (prev.teacherNames.length >= 5) return prev; // 上限
      return { ...prev, teacherNames: [...prev.teacherNames, ''] };
    });
  };

  const removeTeacher = (index: number) => {
    setForm((prev) => {
      // 1人目も削除できるようにして、空欄1つに戻す（入力欄が消えないUI）
      const next = prev.teacherNames.filter((_, i) => i !== index);
      return { ...prev, teacherNames: next.length ? next : [''] };
    });
  };

  const handleReset = () => {
    setForm(initialFormState);
    setPresetCredits(2);
    setCreditInputMode('preset');
    setFormStatus('filling');
    setSubmitError('');
    setLastReviewId('');
  };

  /**
   * teacher_names は任意。
   * - 空欄・空白は除外して送る
   * - 最終的に空なら null を送る（DB側も許容）
   */
  const normalizedTeacherNames = useMemo(() => {
    return form.teacherNames.map((t) => t.trim()).filter((t) => t.length > 0);
  }, [form.teacherNames]);

  /**
   * 単位数：空ならnull、入力があるなら整数として扱う
   */
  const creditsValue = useMemo(() => {
    if (creditInputMode === 'preset') {
      return presetCredits;
    }
    // manual
    const raw = form.manualCredits.trim();
    if (raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) return NaN;
    return n;
  }, [creditInputMode, presetCredits, form.manualCredits]);

  // ----------------------------
  // フォームの妥当性チェック（送信ボタンの活性/非活性）
  // ----------------------------
  const isFormValid = useMemo(() => {
    return Object.values(validationStatus).every(Boolean);
  }, [validationStatus]);

  useEffect(() => {
    setValidationStatus({
      university: form.university.trim().length > 0,
      faculty: form.faculty.trim().length > 0,
      gradeAtTake: form.gradeAtTake > 0,
      courseName: form.courseName.trim().length > 0,
      academicYear: form.academicYear >= 1990 && form.academicYear <= 2100,
      term: form.term.trim().length > 0,
      requirementTypeAtTake: form.requirementTypeAtTake.trim().length > 0,
      performanceSelf: form.performanceSelf >= 1 && form.performanceSelf <= 4,
      assignmentDifficulty4: form.assignmentDifficulty4 >= 1 && form.assignmentDifficulty4 <= 4,
      ratings: Object.values(form.ratings).every((val) => val >= 1 && val <= 5),
      comment: charLen(form.comment.trim()) >= MIN_COMMENT_LENGTH,
      credits: creditsValue === null || (Number.isFinite(creditsValue) && creditsValue > 0),
    });
  }, [form, creditsValue]);

  // ----------------------------
  // 送信処理
  // ----------------------------
  const handleSubmit = async () => {
    if (!isFormValid || formStatus === 'submitting') return;

    setFormStatus('submitting');
    setSubmitError('');

    try {
      // LINE userId が取れてないと、サーバ側で users.id を作れない
      if (!lineUserId) {
        throw new Error('LINEユーザー情報を取得できていません（LIFF未初期化 or 開発用ID未設定）');
      }

      // APIが受け取るsnake_case payloadに合わせて組み立てる
      const payload = {
        university_name: form.university.trim(),
        faculty: form.faculty.trim(),
        department: form.department.trim() || null,
        grade_at_take: form.gradeAtTake,

        subject_name: form.courseName.trim(),

        // ★教員は任意：空ならnull（route.tsでもnull扱いするが、前で揃えておく）
        teacher_names: normalizedTeacherNames.length > 0 ? normalizedTeacherNames : null,

        academic_year: form.academicYear,
        term: form.term,
        credits_at_take: creditsValue,
        requirement_type_at_take: form.requirementTypeAtTake,

        performance_self: form.performanceSelf,
        assignment_difficulty_4: form.assignmentDifficulty4,

        ...form.ratings,

        body_main: form.comment.trim(),
      };

      const res = await fetch('/api/course-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_user_id: lineUserId,
          ...payload,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        // route.ts は { error, details } を返すので、detailsがあれば表示に混ぜて原因追跡しやすくする
        const baseMsg =
          typeof json?.error === 'string'
            ? json.error
            : json?.error?.message
              ? json.error.message
              : `投稿に失敗しました（HTTP ${res.status}）`;

        const detailMsg =
          typeof json?.details?.message === 'string' ? ` / ${json.details.message}` : '';

        throw new Error(`${baseMsg}${detailMsg}`);
      }

      setLastReviewId(json.review_id ?? '');
      setFormStatus('success');
    } catch (e: any) {
      setSubmitError(e?.message ?? '送信処理でエラーが発生しました');
      setFormStatus('filling');
    }
  };

  // 送信完了画面
  if (formStatus === 'success') {
    return (
      <main className="flex min-h-screen items-center justify-center px-3 py-4 sm:px-4">
        <div className="w-full max-w-xl text-center">
          <div className="rounded-2xl bg-white/80 p-8 shadow-soft backdrop-blur-sm">
            <svg
              className="mx-auto h-16 w-16 text-emerald-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <h1 className="mt-4 text-2xl font-bold text-gray-800">投稿が完了しました</h1>
            <p className="mt-2 text-sm text-gray-600">
              ご協力いただきありがとうございます。いただいたレビューは、他の学生の貴重な情報源となります。
            </p>
            {lastReviewId && (
              <p className="mt-2 text-xs text-gray-500">Review ID: {lastReviewId}</p>
            )}
            <button type="button" onClick={handleReset} className="button-primary mt-8 w-full max-w-xs">
              別のレビューを投稿する
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen justify-center px-3 py-4 sm:px-4">
      <div className="w-full max-w-xl space-y-4 rounded-2xl bg-white/80 p-4 shadow-soft backdrop-blur-sm">
        <header className="space-y-1">
          <p className="text-lg font-bold text-gray-900">授業レビュー投稿</p>
          <p className="text-sm text-gray-600">スマホで入力しやすいフォームに最適化しています</p>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="badge-soft">レビュー投稿フォーム</span>
          </div>

          {/* デバッグ表示：このシステムで使うユーザーID（users.id） */}
          <div className="mt-2 text-xs text-gray-700">
            <span className="font-semibold">User ID</span>：
            {systemUserId ? (
              <span className="ml-1 font-mono">{systemUserId}</span>
            ) : (
              <span className="ml-1 text-gray-500">未取得</span>
            )}
          </div>

          {/* 失敗したらここに出す */}
          {systemUserError ? (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              users.id の解決に失敗：{systemUserError}
            </div>
          ) : null}

          {/* LINE生IDは一応残す（開発のときだけ見たいならここをdevelopment限定にしてOK） */}
          <div className="mt-1 text-[11px] text-gray-500">
            <span className="font-semibold">LINE user</span>：{lineUserId ? lineUserId : '未取得'}
          </div>
        </header>

        {liffError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            LIFF: {liffError}
          </div>
        ) : null}

        {submitError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {submitError}
          </div>
        ) : null}

        <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <SectionCard title="ユーザー情報" subtitle="大学・学部・学年（受講時点）を入力してください">
            <div className="grid gap-4">
              <div className="field-wrapper">
                <label className="label" htmlFor="university">
                  <span className="flex items-center">
                    <RequiredBadge />
                    大学名
                    {validationStatus.university && <CheckIcon />}
                  </span>
                </label>
                <input
                  id="university"
                  className="control"
                  placeholder="例：東京大学"
                  value={form.university}
                  onChange={(e) => handleTextChange('university', e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field-wrapper">
                  <label className="label" htmlFor="faculty">
                    <span className="flex items-center">
                      <RequiredBadge />
                      学部名
                      {validationStatus.faculty && <CheckIcon />}
                    </span>
                  </label>
                  <input
                    id="faculty"
                    className="control"
                    placeholder="例：工学部"
                    value={form.faculty}
                    onChange={(e) => handleTextChange('faculty', e.target.value)}
                  />
                </div>

                <div className="field-wrapper">
                  <label className="label" htmlFor="department">
                    学科名
                  </label>
                  <input
                    id="department"
                    className="control"
                    placeholder="例：情報工学科（任意）"
                    value={form.department}
                    onChange={(e) => handleTextChange('department', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-wrapper sm:max-w-xs">
                <label className="label" htmlFor="gradeAtTake">
                  <span className="flex items-center">
                    <RequiredBadge />
                    学年
                    {validationStatus.gradeAtTake && <CheckIcon />}
                  </span>
                </label>
                <select
                  id="gradeAtTake"
                  className="control"
                  value={form.gradeAtTake === 0 ? '' : String(form.gradeAtTake)}
                  onChange={(e) => handleNumberChange('gradeAtTake', Number(e.target.value))}
                >
                  <option value="">学年を選択</option>
                  {gradeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="授業情報" subtitle="科目名を入力してください（教員名は任意です）">
            <div className="grid gap-4">
              <div className="field-wrapper">
                <label className="label" htmlFor="courseName">
                  <span className="flex items-center">
                    <RequiredBadge />
                    科目名
                    {validationStatus.courseName && <CheckIcon />}
                  </span>
                </label>
                <input
                  id="courseName"
                  className="control"
                  placeholder="例：データベース概論"
                  value={form.courseName}
                  onChange={(e) => handleTextChange('courseName', e.target.value)}
                />
              </div>

              <div className="space-y-3">
                {form.teacherNames.map((name, idx) => (
                  <div key={idx} className="grid gap-2">
                    <div className="flex items-end justify-between gap-2">
                      <label className="label" htmlFor={`teacher-${idx}`}>
                        教員名（任意）
                      </label>
                      {form.teacherNames.length > 1 ? (
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-gray-800"
                          onClick={() => removeTeacher(idx)}
                        >
                          削除
                        </button>
                      ) : null}
                    </div>
                    <input
                      id={`teacher-${idx}`}
                      className="control"
                      placeholder={idx === 0 ? '例：山田太郎（空欄OK）' : '例：共同担当の先生（任意）'}
                      value={name}
                      onChange={(e) => updateTeacherName(idx, e.target.value)}
                    />
                  </div>
                ))}

                <div>
                  <button
                    type="button"
                    className="button-secondary w-full sm:w-auto"
                    onClick={addTeacher}
                    disabled={form.teacherNames.length >= 5}
                  >
                    ＋ 教員を追加（任意）
                  </button>
                  <p className="mt-1 text-xs text-gray-500">複数教員の場合のみ追加してください（最大5名）</p>
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="受講情報" subtitle="年度・学期・必修区分などを入力してください">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field-wrapper">
                <label className="label" htmlFor="academicYear">
                  <span className="flex items-center">
                    <RequiredBadge />
                    受講年度
                    {validationStatus.academicYear && <CheckIcon />}
                  </span>
                </label>
                <select
                  id="academicYear"
                  className="control"
                  value={String(form.academicYear)}
                  onChange={(e) => handleNumberChange('academicYear', Number(e.target.value))}
                >
                  {academicYearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}年度
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-wrapper">
                <label className="label" htmlFor="term">
                  <span className="flex items-center">
                    <RequiredBadge />
                    学期
                    {validationStatus.term && <CheckIcon />}
                  </span>
                </label>
                <select
                  id="term"
                  className="control"
                  value={form.term}
                  onChange={(e) => handleTextChange('term', e.target.value)}
                >
                  <option value="">学期を選択</option>
                  {termOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-wrapper">
                <label className="label">
                  <span className="flex items-center">
                    単位数
                    {validationStatus.credits && <CheckIcon />}
                  </span>
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {[1, 2, 4].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => {
                        setCreditInputMode('preset');
                        setPresetCredits(val);
                      }}
                      className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                        creditInputMode === 'preset' && presetCredits === val
                          ? 'bg-brand-600 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      {val}単位
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setCreditInputMode('manual');
                      setPresetCredits(null);
                    }}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                      creditInputMode === 'manual'
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    その他
                  </button>
                </div>

                {creditInputMode === 'manual' && (
                  <div className="mt-3">
                    <input
                      id="creditsAtTake"
                      className="control"
                      inputMode="numeric"
                      placeholder="単位数を入力（任意）"
                      value={form.manualCredits}
                      onChange={(e) => handleTextChange('manualCredits', e.target.value)}
                    />
                    <p className="mt-1 text-xs text-gray-500">空欄OK。入力する場合は正の整数</p>
                  </div>
                )}
              </div>

              <div className="field-wrapper">
                <label className="label" htmlFor="requirementTypeAtTake">
                  <span className="flex items-center">
                    <RequiredBadge />
                    必修/選択
                    {validationStatus.requirementTypeAtTake && <CheckIcon />}
                  </span>
                </label>
                <select
                  id="requirementTypeAtTake"
                  className="control"
                  value={form.requirementTypeAtTake}
                  onChange={(e) => handleTextChange('requirementTypeAtTake', e.target.value)}
                >
                  <option value="">選択してください</option>
                  {requirementTypeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="成績・課題難易度" subtitle="短い選択項目をまとめています（必須）">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 text-sm text-gray-700">
                <p className="label">
                  <span className="flex items-center">
                    <RequiredBadge />
                    成績
                    {validationStatus.performanceSelf && <CheckIcon />}
                  </span>
                </p>
                {performanceOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="performanceSelf"
                      value={opt.value}
                      checked={form.performanceSelf === opt.value}
                      onChange={(e) => handleNumberChange('performanceSelf', Number(e.target.value))}
                      className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-400"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>

              <div className="space-y-2 text-sm text-gray-700">
                <p className="label">
                  <span className="flex items-center">
                    <RequiredBadge />
                    課題の難易度
                    {validationStatus.assignmentDifficulty4 && <CheckIcon />}
                  </span>
                </p>
                {assignmentDifficultyOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="assignmentDifficulty4"
                      value={opt.value}
                      checked={form.assignmentDifficulty4 === opt.value}
                      onChange={(e) => handleNumberChange('assignmentDifficulty4', Number(e.target.value))}
                      className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="評価"
            subtitle="すべての項目を1~5で評価してください（教材や形式はコメント欄に書いてください）"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {assessmentOptions.map((item) => {
                const label = (
                  <span className="flex items-center">
                    <RequiredBadge />
                    {item.label}
                    {validationStatus.ratings && <CheckIcon />}
                  </span>
                );

                if (item.key === 'assignment_load') {
                  return (
                    <div key={item.key}>
                      <StarRating
                        label={label}
                        value={form.ratings[item.key]}
                        onChange={(val) => updateRating(item.key, val)}
                        starColor="text-yellow-400"
                      />
                      <div className="mt-1 flex justify-between px-0.5 text-xs text-gray-500">
                        <span>少ない</span>
                        <span>多い</span>
                      </div>
                    </div>
                  );
                }
                return (
                  <StarRating
                    key={item.key}
                    label={label}
                    value={form.ratings[item.key]}
                    onChange={(val) => updateRating(item.key, val)}
                    starColor="text-yellow-400"
                  />
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="コメント" subtitle="30文字以上でご記入ください（教材・形式・テスト方式などもここに）">
            <TextCounterTextarea
              label={
                <span className="flex items-center">
                  <RequiredBadge />
                  コメント
                  {validationStatus.comment && <CheckIcon />}
                </span>
              }
              value={form.comment}
              onChange={(val) => handleTextChange('comment', val)}
              minLength={MIN_COMMENT_LENGTH}
              placeholder="例：教材、授業形式、テスト形式、課題量、出席の厳しさなどをまとめて書いてください"
            />
            <p className="mt-1 text-xs text-gray-500">
              判定は「文字数」ではなく、絵文字を含む場合もズレにくいようコードポイントで数えています。
              （目安：{charLen(form.comment.trim())}/{MIN_COMMENT_LENGTH}）
            </p>
          </SectionCard>

          <div className="sticky bottom-0 left-0 right-0 z-10 -mx-4 mt-2 bg-white/95 px-4 pb-3 pt-3 backdrop-blur">
            <button
              type="button"
              className="button-primary flex w-full items-center justify-center"
              disabled={!isFormValid || formStatus === 'submitting'}
              onClick={handleSubmit}
            >
              {formStatus === 'submitting' ? (
                <>
                  <SpinnerIcon />
                  送信中...
                </>
              ) : (
                'レビューを投稿する'
              )}
            </button>
            <p className="mt-2 text-xs text-gray-500">
              ローカル開発では NEXT_PUBLIC_DEV_LINE_USER_ID があればそれを使います。
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
