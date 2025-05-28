// sfms/app/dashboard/student-registration/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { toast } from 'sonner';
import { Database } from '@/lib/database.types';
import { useAuth } from '@/components/AuthContext';
import Link from 'next/link';

// Types from your provided code, adapted slightly
type ClassType = Pick<Database['public']['Tables']['classes']['Row'], 'id' | 'name'>;
type FeeTypeRow = Database['public']['Tables']['fee_types']['Row']; // default_amount is numeric

// For displaying students in the list
type StudentDisplay = Database['public']['Tables']['students']['Row'] & {
  class_name?: string;
  // This will hold the detailed fee structure for editing/display if needed
  assigned_fee_details?: (FeeTypeRow & { discount?: number; discount_description?: string | null; assigned_amount: number; net_payable_amount: number })[];
};

type StudentInsertPayload = Database['public']['Tables']['students']['Insert'];
type StudentUpdatePayload = Database['public']['Tables']['students']['Update'];
type StudentFeeTypeInsertPayload = Omit<Database['public']['Tables']['student_fee_types']['Insert'], 'net_payable_amount'>; // Omit net_payable_amount

export default function StudentRegistrationPage() {
  const supabase = createClientComponentClient<Database>();
  const router = useRouter();
  const { user, schoolId, isLoading: authLoading, isSchoolInfoLoading } = useAuth();

  const [name, setName] = useState('');
  const [rollNo, setRollNo] = useState('');
  const [selectedClassId, setSelectedClassId] = useState('');
  const [academicYear, setAcademicYear] = useState(new Date().getFullYear().toString());
  
  const [classes, setClasses] = useState<ClassType[]>([]);
  const [allSchoolFeeTypes, setAllSchoolFeeTypes] = useState<FeeTypeRow[]>([]); // All fee types for the school
  const [filteredFeeTypesForClass, setFilteredFeeTypesForClass] = useState<FeeTypeRow[]>([]);
  const [selectedFeeTypeIds, setSelectedFeeTypeIds] = useState<string[]>([]);
  const [feeAdjustments, setFeeAdjustments] = useState<{
    [feeTypeId: string]: { discount: number; description: string };
  }>({});
  
  const [students, setStudents] = useState<StudentDisplay[]>([]);
  const [editStudentId, setEditStudentId] = useState<string | null>(null);
  
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteStudent, setDeleteStudent] = useState<StudentDisplay | null>(null);
  const [confirmDeleteName, setConfirmDeleteName] = useState('');

  const [pageLoading, setPageLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // --- Data Fetching Callbacks (scoped by schoolId) ---
  const fetchClasses = useCallback(async () => {
    if (!schoolId) { setClasses([]); return; }
    const { data, error } = await supabase.from('classes').select('id, name').eq('school_id', schoolId).order('name');
    if (error) toast.error('Failed to load classes: ' + error.message); else setClasses(data || []);
  }, [supabase, schoolId]);

  const fetchAllFeeTypesForSchool = useCallback(async () => { // Renamed from fetchFeeTypes for clarity
    if (!schoolId) { setAllSchoolFeeTypes([]); return; }
    const { data, error } = await supabase.from('fee_types').select('id, name, default_amount').eq('school_id', schoolId).order('name');
    if (error) toast.error('Failed to load all fee types: ' + error.message); else setAllSchoolFeeTypes(data || []);
  }, [supabase, schoolId]);

  const fetchStudents = useCallback(async () => {
    if (!schoolId) { setStudents([]); return; }
    setPageLoading(true);
    const { data, error } = await supabase
      .from('students')
      .select(`
        id, name, roll_no, class_id, total_fees, academic_year, status, is_passed_out, school_id,
        classes (name), 
        student_fee_types (
          assigned_amount, discount, discount_description, net_payable_amount,
          fee_type: fee_types (id, name, default_amount, scheduled_date)
        )
      `)
      .eq('school_id', schoolId)
      .order('name', { ascending: true });
    
    setPageLoading(false);
    if (error) {
      toast.error('Failed to load students: ' + error.message);
      setStudents([]);
    } else {
      const studentsData: StudentDisplay[] = (data || []).map((student: any) => ({
        ...student,
        class_name: student.classes?.name || 'N/A',
        assigned_fee_details: student.student_fee_types?.map((sft: any) => ({
          ...(sft.fee_type || {}),
          id: sft.fee_type?.id || `missing-fee-${Math.random()}`,
          name: sft.fee_type?.name || 'Unknown Fee Type',
          default_amount: sft.fee_type?.default_amount || 0,
          scheduled_date: sft.fee_type?.scheduled_date || null,
          assigned_amount: sft.assigned_amount || sft.fee_type?.default_amount || 0,
          discount: sft.discount,
          discount_description: sft.discount_description,
          net_payable_amount: sft.net_payable_amount || ((sft.assigned_amount || sft.fee_type?.default_amount || 0) - (sft.discount || 0))
        })) || [],
      }));
      setStudents(studentsData);
    }
  }, [supabase, schoolId]);

  // Initial data load
  useEffect(() => {
    if (user && schoolId && !authLoading && !isSchoolInfoLoading) {
      setPageLoading(true);
      Promise.all([
        fetchClasses(),
        fetchAllFeeTypesForSchool(), // Fetch all fee types for the school
        fetchStudents()
      ]).finally(() => setPageLoading(false));
    } else if (user && !schoolId && !authLoading && !isSchoolInfoLoading) {
      toast.error("School information not loaded. Student Management features disabled.");
      setPageLoading(false);
    } else {
      setPageLoading(authLoading || isSchoolInfoLoading);
    }
  }, [user, schoolId, authLoading, isSchoolInfoLoading, fetchClasses, fetchAllFeeTypesForSchool, fetchStudents]);

  // Filter fee types when class changes
  useEffect(() => {
    if (!selectedClassId || !schoolId) {
      setFilteredFeeTypesForClass([]);
      // Don't reset selections if in edit mode, startEditStudent will handle it.
      if (!editStudentId) {
          setSelectedFeeTypeIds([]);
          setFeeAdjustments({});
      }
      return;
    }
    async function fetchFilteredFeeTypesForSelectedClass() {
      const { data, error } = await supabase
        .from('fee_type_classes')
        .select('fee_types!inner(id, name, default_amount)') // Use !inner to ensure fee_type exists
        .eq('class_id', selectedClassId)
        .eq('school_id', schoolId); // Filter by schoolId

      if (error) {
        toast.error('Failed to load fee types for class: ' + error.message);
        setFilteredFeeTypesForClass([]);
      } else {
        const feeTypesData = data?.map((item: any) => item.fee_types).filter(Boolean) as FeeTypeRow[] || [];
        setFilteredFeeTypesForClass(feeTypesData);
      }
    }
    fetchFilteredFeeTypesForSelectedClass();
  }, [selectedClassId, schoolId, supabase, editStudentId]); // Removed editStudentId from here, let startEdit handle initial state


  const toggleFeeTypeSelection = (id: string) => {
    setSelectedFeeTypeIds((prev) => prev.includes(id) ? prev.filter((fid) => fid !== id) : [...prev, id]);
  };
  const handleDiscountChange = (id: string, val: string) => {
    setFeeAdjustments((prev) => ({ ...prev, [id]: { ...(prev[id] || { description: '' }), discount: parseFloat(val) || 0 }}));
  };
  const handleDescChange = (id: string, val: string) => {
    setFeeAdjustments((prev) => ({ ...prev, [id]: { ...(prev[id] || { discount: 0 }), description: val }}));
  };
  
  const resetForm = () => {
    setName(''); setRollNo(''); setSelectedClassId(''); 
    setAcademicYear(new Date().getFullYear().toString());
    setSelectedFeeTypeIds([]); setFeeAdjustments({});
    setEditStudentId(null);
    toast.dismiss(); // Clear any info/error toasts related to the form
  };

  const startEditStudent = (student: StudentDisplay) => {
    if (student.school_id !== schoolId) { toast.error("Cannot edit: Student does not belong to your school."); return; }
    
    setEditStudentId(student.id);
    setName(student.name);
    setRollNo(student.roll_no || '');
    setAcademicYear(student.academic_year || new Date().getFullYear().toString());
    
    // IMPORTANT: Set selectedClassId FIRST to trigger filtering of fee types for THAT class
    setSelectedClassId(student.class_id); 

    // Defer setting fee type selections until filteredFeeTypesForClass is updated for the student's class
    // This is a common pattern: set dependent state in a subsequent useEffect or after a delay
    setTimeout(() => {
        const feeIds = student.assigned_fee_details?.map((ft) => ft.id).filter(Boolean) as string[] || [];
        setSelectedFeeTypeIds(feeIds);
        const adjustments: typeof feeAdjustments = {};
        student.assigned_fee_details?.forEach((ft) => {
          if(ft.id) {
            adjustments[ft.id] = { discount: ft.discount || 0, description: ft.discount_description || '' };
          }
        });
        setFeeAdjustments(adjustments);
    }, 0); // Small delay to allow filteredFeeTypesForClass to potentially update

    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();

    if (!schoolId) { toast.error("School information is missing. Cannot proceed."); return; }
    if (!name.trim() || !rollNo.trim() || !selectedClassId || !academicYear) {
      toast.error('Name, Roll No, Class, and Academic Year are required.'); return;
    }
    // This validation was in your original code, it's good to have.
    if (selectedFeeTypeIds.length === 0 && filteredFeeTypesForClass.length > 0) { 
      toast.error('Please assign at least one fee type from the available list for the class, or ensure no fees are applicable.'); 
      // return; // Uncomment if selection is mandatory
    }


    setIsSubmitting(true);
    const toastId = toast.loading(editStudentId ? 'Updating student...' : 'Registering student...');

    const totalFeesCalculated = filteredFeeTypesForClass
      .filter((ft) => selectedFeeTypeIds.includes(ft.id))
      .reduce((sum, ft) => {
        const disc = feeAdjustments[ft.id]?.discount || 0;
        return sum + (ft.default_amount || 0) - disc;
      }, 0);

    const studentBasePayload = {
      name: name.trim(),
      roll_no: rollNo.trim(),
      class_id: selectedClassId,
      academic_year: academicYear.trim(),
      total_fees: totalFeesCalculated,
      school_id: schoolId, // CRITICAL
      // status & is_passed_out will use DB defaults
    };
    console.log("Student form handleSubmit. Payload for 'students' table:", studentBasePayload);

    try {
      let studentIdForFeeLinks: string;
      let operation: 'updated' | 'registered' = 'registered';

      if (editStudentId) {
        operation = 'updated';
        const { data: updatedStudent, error: updateError } = await supabase
          .from('students')
          .update(studentBasePayload as StudentUpdatePayload)
          .eq('id', editStudentId)
          .eq('school_id', schoolId)
          .select()
          .single();
        if (updateError) throw updateError;
        if (!updatedStudent) throw new Error("Failed to retrieve student data after update.");
        studentIdForFeeLinks = updatedStudent.id;

        await supabase.from('student_fee_types').delete().eq('student_id', editStudentId).eq('school_id', schoolId);
      } else {
        const { data: newStudent, error: studentError } = await supabase
          .from('students')
          .insert(studentBasePayload as StudentInsertPayload)
          .select()
          .single();
        if (studentError) throw studentError;
        if (!newStudent) throw new Error("Failed to retrieve new student data after insert.");
        studentIdForFeeLinks = newStudent.id;
      }

      if (selectedFeeTypeIds.length > 0) {
        const feeLinksToInsert: StudentFeeTypeInsertPayload[] = selectedFeeTypeIds.map((fee_type_id) => {
          const originalFee = filteredFeeTypesForClass.find(ft => ft.id === fee_type_id);
          const assignedAmount = originalFee?.default_amount || 0;
          const discount = feeAdjustments[fee_type_id]?.discount || 0;
          // net_payable_amount is NOT explicitly set here, assuming DB calculates it or it's not strictly needed for insert if default exists
          return {
            student_id: studentIdForFeeLinks,
            fee_type_id,
            school_id: schoolId, 
            assigned_amount: assignedAmount, // Storing the original fee amount before discount for this link
            discount: discount,
            discount_description: feeAdjustments[fee_type_id]?.description.trim() || null,
          };
        });
        console.log("Attempting to insert/update student_fee_types:", feeLinksToInsert);
        const { error: feeLinkError } = await supabase.from('student_fee_types').insert(feeLinksToInsert);
        if (feeLinkError) throw feeLinkError;
      }
      
      toast.success(`Student ${operation} successfully!`, { id: toastId });
      resetForm(); 
      fetchStudents(); // Refresh student list
    } catch (error: any) {
      toast.error(`Operation failed: ${error.message}`, { id: toastId });
      console.error(`Error student ${editStudentId ? 'update' : 'registration'}:`, error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openDeleteModal = (student: StudentDisplay) => {
    if (student.school_id !== schoolId) { toast.error("Cannot delete: Student does not belong to your school."); return; }
    setDeleteStudent(student); setConfirmDeleteName(''); setDeleteModalOpen(true);
  };
  const closeDeleteModal = () => {
    setDeleteModalOpen(false); setDeleteStudent(null); setConfirmDeleteName('');
  };
  const confirmDelete = async () => {
    if (!deleteStudent || !schoolId || confirmDeleteName !== deleteStudent.name) {
      if(confirmDeleteName !== deleteStudent?.name) toast.error('Student name does not match.');
      return;
    }
    setIsSubmitting(true);
    const toastId = toast.loading('Deleting student...');
    try {
      await supabase.from('student_fee_types').delete().eq('student_id', deleteStudent.id).eq('school_id', schoolId);
      await supabase.from('students').delete().eq('id', deleteStudent.id).eq('school_id', schoolId);
      toast.success('Student deleted successfully!', { id: toastId });
      closeDeleteModal(); fetchStudents();
    } catch (error: any) {
      toast.error(`Failed to delete student: ${error.message}`, { id: toastId });
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Render Logic ---
  if (authLoading || (pageLoading && students.length === 0 && !schoolId && !user)) { // Adjusted initial loading condition
    return <div className="p-6 text-center">Loading Student Registration module...</div>;
  }
  if (!user) { return <div className="p-6 text-center">Please log in.</div>; }
  if (!schoolId && !isSchoolInfoLoading) {
    return <div className="p-6 text-center text-red-500">School information unavailable. Student management disabled.</div>;
  }
  
  return (
    <main className="p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold mb-6 text-gray-800 text-center">
        {editStudentId ? `Edit Details for ${name}` : 'New Student Registration'}
      </h1>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-5 mb-10 bg-white p-6 rounded-lg shadow-xl">
        <fieldset className="border border-gray-300 p-4 rounded-md">
          <legend className="text-lg font-semibold text-gray-700 px-2">Student Information</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-2">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name <span className="text-red-500">*</span></label>
              <input type="text" id="name" placeholder="Full Name" value={name} onChange={(e) => setName(e.target.value)} required 
                     className="mt-1 w-full p-2.5 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
            </div>
            <div>
              <label htmlFor="rollNo" className="block text-sm font-medium text-gray-700">Roll Number <span className="text-red-500">*</span></label>
              <input type="text" id="rollNo" placeholder="Roll No." value={rollNo} onChange={(e) => setRollNo(e.target.value)} required 
                     className="mt-1 w-full p-2.5 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
            </div>
            <div>
              <label htmlFor="selectedClassId" className="block text-sm font-medium text-gray-700">Class <span className="text-red-500">*</span></label>
              <select id="selectedClassId" value={selectedClassId} onChange={(e) => setSelectedClassId(e.target.value)} required
                      disabled={classes.length === 0}
                      className="mt-1 w-full p-2.5 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white disabled:bg-gray-100 disabled:cursor-not-allowed">
                <option value="" disabled>Select Class</option>
                {classes.map((cls) => (<option key={cls.id} value={cls.id}>{cls.name}</option>))}
              </select>
              {classes.length === 0 && !pageLoading && <p className="text-xs text-red-500 mt-1">No classes configured for this school.</p>}
            </div>
            <div>
              <label htmlFor="academicYear" className="block text-sm font-medium text-gray-700">Academic Year <span className="text-red-500">*</span></label>
              <select id="academicYear" value={academicYear} onChange={(e) => setAcademicYear(e.target.value)} required
                      className="mt-1 w-full p-2.5 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white">
                <option value="">Select Year</option>
                {[0, 1, 2, 3, 4].map((i) => { // Show current year and next few
                    const year = new Date().getFullYear() - 2 + i; // Example: 2022-2023 to 2026-2027
                    return <option key={year} value={`${year}-${year + 1}`}>{`${year}-${year + 1}`}</option>;
                })}
              </select>
            </div>
          </div>
        </fieldset>

        {selectedClassId && (
          <fieldset className="border border-gray-300 p-4 rounded-md">
            <legend className="text-lg font-semibold text-gray-700 px-2">Assign Applicable Fees</legend>
            {filteredFeeTypesForClass.length > 0 ? (
              <div className="space-y-3 mt-2 max-h-72 overflow-y-auto pr-2">
                {filteredFeeTypesForClass.map((ft) => (
                  <div key={ft.id} className="p-3 border rounded-md bg-slate-50 shadow-sm">
                    <label className="flex items-center justify-between space-x-2 cursor-pointer mb-2">
                      <div className="flex items-center">
                        <input type="checkbox" checked={selectedFeeTypeIds.includes(ft.id)} onChange={() => toggleFeeTypeSelection(ft.id)} 
                               className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"/>
                        <span className="ml-2 text-sm text-gray-800 font-medium">{ft.name}</span>
                      </div>
                      <span className="text-sm text-gray-600">₹{ft.default_amount?.toFixed(2)}</span>
                    </label>
                    {selectedFeeTypeIds.includes(ft.id) && (
                      <div className="pl-6 space-y-2 mt-1">
                        <input type="number" min={0} max={ft.default_amount || undefined} placeholder="Discount Amount (₹)"
                               value={feeAdjustments[ft.id]?.discount || ''}
                               onChange={(e) => handleDiscountChange(ft.id, e.target.value)}
                               className="w-full sm:w-1/2 p-2 border border-gray-300 rounded-md text-sm shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
                        <input type="text" placeholder="Reason for Discount (Optional)"
                               value={feeAdjustments[ft.id]?.description || ''}
                               onChange={(e) => handleDescChange(ft.id, e.target.value)}
                               className="w-full p-2 border border-gray-300 rounded-md text-sm shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 mt-2">
                {isSubmitting ? 'Loading fee types...' : 'No specific fee types assigned to this class. Student will be registered with 0 assigned fees unless general fees apply.'}
              </p>
            )}
          </fieldset>
        )}

        <div className="flex items-center justify-end space-x-3 pt-3 border-t mt-6">
          {editStudentId && (
            <button type="button" onClick={cancelEdit} disabled={isSubmitting}
                    className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors">
              Cancel
            </button>
          )}
          <button type="submit" disabled={isSubmitting || pageLoading || !schoolId }
                  className="px-6 py-2.5 bg-indigo-600 text-white font-semibold rounded-lg shadow-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors">
            {isSubmitting ? (editStudentId ? 'Updating...' : 'Registering...') : (editStudentId ? 'Save Student Changes' : 'Register Student')}
          </button>
        </div>
      </form>

      <hr className="my-10 border-t-2 border-gray-200"/>

      <h2 className="text-2xl font-semibold mb-5 text-gray-800 text-center">Registered Students List</h2>
      {pageLoading && students.length === 0 ? (
         <p className="text-center text-gray-500">Loading student list...</p>
      ) : !pageLoading && students.length === 0 && schoolId ? (
        <p className="text-center text-gray-500 py-6">No students registered for this school yet.</p>
      ) : students.length > 0 ? (
        <div className="overflow-x-auto bg-white shadow-xl rounded-lg">
          <table className="w-full min-w-[700px] border-collapse">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-3 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Name</th>
                <th className="p-3 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Roll No</th>
                <th className="p-3 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Class</th>
                <th className="p-3 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Academic Year</th>
                <th className="p-3 text-right text-xs font-medium text-gray-600 uppercase tracking-wider">Total Fees (₹)</th>
                <th className="p-3 text-center text-xs font-medium text-gray-600 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {students.map((st) => (
                <tr key={st.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 whitespace-nowrap text-sm font-medium text-indigo-600 hover:underline">
                    <Link href={`/dashboard/student/${st.id}`}>{st.name}</Link>
                  </td>
                  <td className="p-3 whitespace-nowrap text-sm text-gray-700">{st.roll_no}</td>
                  <td className="p-3 whitespace-nowrap text-sm text-gray-700">{st.class_name}</td>
                  <td className="p-3 whitespace-nowrap text-sm text-gray-700">{st.academic_year}</td>
                  <td className="p-3 whitespace-nowrap text-sm text-gray-700 text-right">{st.total_fees?.toFixed(2)}</td>
                  <td className="p-3 whitespace-nowrap text-sm font-medium space-x-3 text-center">
                    <button onClick={() => startEditStudent(st)} className="text-indigo-600 hover:text-indigo-800 transition-colors">Edit</button>
                    <button onClick={() => openDeleteModal(st)} className="text-red-600 hover:text-red-800 transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Delete Modal */}
      {deleteModalOpen && deleteStudent && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50" onClick={closeDeleteModal}>
          <div className="bg-white rounded-lg p-6 shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4 text-gray-800">Confirm Deletion</h3>
            <p className="mb-4 text-sm text-gray-600">
              To confirm, please type the student&apos;s full name: <strong className="text-gray-900">{deleteStudent.name}</strong>
            </p>
            <input type="text" value={confirmDeleteName} onChange={(e) => setConfirmDeleteName(e.target.value)}
                   className="w-full p-2 border border-gray-300 rounded-md mb-4 shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
                   placeholder="Type full student name"/>
            <div className="flex justify-end space-x-3">
              <button onClick={closeDeleteModal} disabled={isSubmitting} className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">Cancel</button>
              <button onClick={confirmDelete} disabled={isSubmitting || confirmDeleteName !== deleteStudent.name}
                      className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-300">
                {isSubmitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}