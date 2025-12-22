'use client';

import { useMemo, useState } from 'react';
import SectionCard from '../components/SectionCard';
import StarRating from '../components/StarRating';
import TextCounterTextarea from '../components/TextCounterTextarea';

const MIN_COMMENT_LENGTH = 30;

const academicYears = ['1年', '2年', '3年', '4年', 'その他'];
const classFormats = ['講義', '演習', 'グループワーク', 'レポート'];
const materials = ['スライド', '教科書', 'プリント', '動画教材'];
const courseGrades = ['未評価', '単位なし', '単位あり（普通）', '単位あり（高評価）'];
const assignmentDifficulties = ['無し', '易', '中', '難'];

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
    courseGrade: '',
    comment: '',
    assignmentDifficulty: '',
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
    const requiredText = [
      form.university,
      form.faculty,
      form.academicYear,
      form.courseName,
      form.instructor,
      form.courseGrade,
      form.assignmentDifficulty,
    ];
    const hasAllRatings = Object.values(form.ratings).every((val) => val > 0);
    const hasComment = form.comment.trim().length >= MIN_COMMENT_LENGTH;
    return requiredText.every((v) => v.trim().length > 0) && hasAllRatings && hasComment;
  }, [form]);

  return (
    <main className="flex min-h-screen justify-center px-4 py-6 sm:px-6 lg:px-8">
      <div className="w-full max-w-4xl space-y-6 rounded-2xl bg-white/80 p-4 shadow-soft backdrop-blur-sm sm:p-6 lg:p-8">
        <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-bold text-gray-900">授業レビュー投稿</p>
            <p className="text-sm text-gray-600">大学生向けの授業レビューを共有しましょう</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <span className="badge-soft">レビュー投稿フォーム</span>
            <span className="text-xs">必須項目は「＊」が付いています</span>
          </div>
        </header>

        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 lg:p-7">
          <div className="space-y-5 lg:space-y-4">
            <div className="grid gap-5 lg:grid-cols-2">
              <SectionCard className="lg:col-span-2" title="ユーザー情報" subtitle="大学と学年を入力してください">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="field-wrapper md:col-span-2">
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
                  <div className="field-wrapper md:col-span-2">
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
                  <div className="field-wrapper md:col-span-2">
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
                  <div className="field-wrapper md:max-w-xs">
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
                <div className="grid gap-6 md:grid-cols-2">
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

              <SectionCard className="lg:col-span-2" title="評価" subtitle="すべての項目を1~5で評価してください">
                <div className="grid gap-4 md:grid-cols-2">
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

              <SectionCard title="成績" subtitle="取得した成績を選択してください（必須）">
                <div className="space-y-2 text-sm text-gray-700">
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
              </SectionCard>

              <SectionCard title="課題の難易度" subtitle="レポート・課題の難易度を選択してください（必須）">
                <div className="space-y-2 text-sm text-gray-700">
                  {assignmentDifficulties.map((level) => (
                    <label key={level} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="assignmentDifficulty"
                        value={level}
                        checked={form.assignmentDifficulty === level}
                        onChange={(e) => handleChange('assignmentDifficulty', e.target.value)}
                        className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-400"
                      />
                      <span>{level}</span>
                    </label>
                  ))}
                </div>
              </SectionCard>

              <SectionCard className="lg:col-span-2" title="コメント" subtitle="30文字以上でご記入ください">
                <TextCounterTextarea
                  label="コメント"
                  value={form.comment}
                  onChange={(val) => handleChange('comment', val)}
                  minLength={MIN_COMMENT_LENGTH}
                  placeholder="テスト形式、課題量、出席の厳しさなど一言でOK"
                />
              </SectionCard>
            </div>

            <div className="sticky bottom-0 left-0 right-0 z-10 -mx-4 mt-2 bg-white/95 px-4 pb-2 pt-3 backdrop-blur sm:static sm:mx-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0">
              <div className="flex justify-end">
                <button
                  type="button"
                  className="button-primary w-full sm:w-auto sm:min-w-[240px]"
                  disabled={!isFormValid}
                >
                  <span role="img" aria-label="send">
                    ✉️
                  </span>
                  レビューを投稿する
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
