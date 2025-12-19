'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, CircleEllipsis, Menu, Share2 } from 'lucide-react';
import SectionCard from '../components/SectionCard';
import StarRating from '../components/StarRating';
import TextCounterTextarea from '../components/TextCounterTextarea';

const MIN_COMMENT_LENGTH = 30;

const academicYears = ['1年', '2年', '3年', '4年', 'その他'];
const classFormats = ['講義', '演習', 'グループワーク', 'レポート'];
const materials = ['スライド', '教科書', 'プリント', '動画教材'];
const courseGrades = ['未評価', '単位なし', '単位あり（普通）', '単位あり（高評価）'];

const assessmentOptions = [
  { key: 'creditEase', label: '単位取得の容易さ' },
  { key: 'difficulty', label: '難易度' },
  { key: 'assignmentVolume', label: '課題量' },
  { key: 'attendance', label: '出席の厳しさ' },
  { key: 'satisfaction', label: '満足度' },
  { key: 'recommendation', label: 'おすすめ度' },
] as const;

type RatingKey = (typeof assessmentOptions)[number]['key'];

export default function ReviewFormPage() {
  const [form, setForm] = useState({
    university: '',
    faculty: '',
    department: '',
    academicYear: '',
    courseName: '',
    instructor: '',
    formats: [] as string[],
    materials: [] as string[],
    courseGrade: courseGrades[0],
    comment: '',
    ratings: assessmentOptions.reduce((acc, curr) => ({ ...acc, [curr.key]: 0 }), {}) as Record<RatingKey, number>,
  });

  const toggleCheckbox = (field: 'formats' | 'materials', value: string) => {
    setForm((prev) => {
      const exists = prev[field].includes(value);
      const nextValues = exists ? prev[field].filter((v) => v !== value) : [...prev[field], value];
      return { ...prev, [field]: nextValues };
    });
  };

  const updateRating = (key: RatingKey, value: number) => {
    setForm((prev) => ({ ...prev, ratings: { ...prev.ratings, [key]: value } }));
  };

  const handleChange = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const isFormValid = useMemo(() => {
    const requiredText = [form.university, form.faculty, form.academicYear, form.courseName, form.instructor];
    const hasAllRatings = Object.values(form.ratings).every((val) => val > 0);
    const hasComment = form.comment.trim().length >= MIN_COMMENT_LENGTH;
    return requiredText.every((v) => v.trim().length > 0) && hasAllRatings && hasComment;
  }, [form]);

  return (
    <main className="flex min-h-screen justify-center px-3 py-4 sm:px-6">
      <div className="w-full max-w-3xl space-y-4 rounded-2xl bg-white/70 p-4 shadow-soft backdrop-blur-sm sm:p-6">
        <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-black text-white">
              <span className="text-sm font-bold">VR</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">University review app</p>
              <p className="text-xs text-gray-500">プレビュー</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-semibold text-gray-700 shadow-sm hover:bg-gray-50">
              Sign In
            </button>
            <button className="rounded-md bg-black px-3 py-1.5 font-semibold text-white shadow-sm hover:bg-gray-900">
              Sign Up
            </button>
          </div>
        </header>

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-sm font-semibold text-gray-600 sm:px-4">
            <div className="flex items-center gap-1">
              <button className="rounded-md p-1 text-gray-500 hover:bg-gray-100">
                <Menu className="h-4 w-4" />
              </button>
              <span>チャット</span>
              <span className="rounded-md bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">Preview</span>
            </div>
            <div className="flex items-center gap-1 text-gray-500">
              <Share2 className="h-4 w-4" />
              <CircleEllipsis className="h-4 w-4" />
            </div>
          </div>

          <div className="border-b border-slate-100 px-3 py-2 sm:px-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-gray-700">/&nbsp;</span>
              <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-gray-700">Latest</span>
              <ChevronDown className="h-4 w-4" />
              <CircleEllipsis className="h-4 w-4" />
            </div>
          </div>

          <div className="max-h-[80vh] space-y-4 overflow-y-auto px-3 py-4 sm:px-5">
            <h1 className="text-xl font-bold text-gray-900">授業レビュー投稿</h1>

            <SectionCard title="ユーザー情報" subtitle="大学と学年を入力してください">
              <div className="field-wrapper">
                <label className="label" htmlFor="university">
                  大学名＊
                </label>
                <input
                  id="university"
                  className="control"
                  placeholder="例：東京大学"
                  value={form.university}
                  onChange={(e) => handleChange('university', e.target.value)}
                />
              </div>
              <div className="field-wrapper">
                <label className="label" htmlFor="faculty">
                  学部名＊
                </label>
                <input
                  id="faculty"
                  className="control"
                  placeholder="例：工学部"
                  value={form.faculty}
                  onChange={(e) => handleChange('faculty', e.target.value)}
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
                  onChange={(e) => handleChange('department', e.target.value)}
                />
              </div>
              <div className="field-wrapper">
                <label className="label" htmlFor="academicYear">
                  学年＊
                </label>
                <select
                  id="academicYear"
                  className="control"
                  value={form.academicYear}
                  onChange={(e) => handleChange('academicYear', e.target.value)}
                >
                  <option value="">学年を選択</option>
                  {academicYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            </SectionCard>

            <SectionCard title="授業情報" subtitle="科目と教員名を入力してください">
              <div className="field-wrapper">
                <label className="label" htmlFor="courseName">
                  科目名＊
                </label>
                <input
                  id="courseName"
                  className="control"
                  placeholder="例：データベース概論"
                  value={form.courseName}
                  onChange={(e) => handleChange('courseName', e.target.value)}
                />
              </div>
              <div className="field-wrapper">
                <label className="label" htmlFor="instructor">
                  教員名＊
                </label>
                <input
                  id="instructor"
                  className="control"
                  placeholder="例：山田太郎"
                  value={form.instructor}
                  onChange={(e) => handleChange('instructor', e.target.value)}
                />
              </div>
            </SectionCard>

            <SectionCard title="授業の特徴" subtitle="該当するものをすべて選択してください（任意）">
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="label">授業形式</p>
                  <div className="checklist">
                    {classFormats.map((item) => (
                      <label key={item} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
                          checked={form.formats.includes(item)}
                          onChange={() => toggleCheckbox('formats', item)}
                        />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="label">教材</p>
                  <div className="checklist">
                    {materials.map((item) => (
                      <label key={item} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
                          checked={form.materials.includes(item)}
                          onChange={() => toggleCheckbox('materials', item)}
                        />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="評価" subtitle="すべての項目を1~5で評価してください">
              <div className="space-y-4">
                {assessmentOptions.map((item) => (
                  <StarRating
                    key={item.key}
                    label={`${item.label}＊`}
                    value={form.ratings[item.key]}
                    onChange={(val) => updateRating(item.key, val)}
                  />
                ))}
              </div>
            </SectionCard>

            <SectionCard title="成績" subtitle="取得した成績を選択してください（任意）">
              <div className="space-y-3 text-sm text-gray-700">
                <div className="space-y-2">
                  {courseGrades.map((grade) => (
                    <label key={grade} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="courseGrade"
                        value={grade}
                        checked={form.courseGrade === grade}
                        onChange={(e) => handleChange('courseGrade', e.target.value)}
                        className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-400"
                      />
                      <span>{grade}</span>
                    </label>
                  ))}
                </div>
              </div>
            </SectionCard>

            <SectionCard title="コメント" subtitle="30文字以上でご記入ください">
              <TextCounterTextarea
                label="コメント"
                value={form.comment}
                onChange={(val) => handleChange('comment', val)}
                minLength={MIN_COMMENT_LENGTH}
                placeholder="テスト形式、課題量、出席の厳しさなど一言でOK"
              />
            </SectionCard>

            <div className="pb-4">
              <button type="button" className="button-primary" disabled={!isFormValid}>
                <span role="img" aria-label="send">
                  ✉️
                </span>
                レビューを投稿する
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
