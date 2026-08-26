import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getVintedCategoryById } from "@/lib/listing-studio/vinted-categories-data";

export const runtime = "nodejs";

/** Looks up one category by its Vinted id, regardless of active/selectable state — used by Listings Review to render a previously-chosen category's path even after a later refresh deactivates it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOwner();
    const { id } = await params;
    const categoryId = Number(id);
    if (!Number.isInteger(categoryId) || categoryId <= 0) return NextResponse.json({ error: "Invalid category id." }, { status: 400 });

    const category = await getVintedCategoryById(categoryId);
    if (!category) return NextResponse.json({ error: "Category not found." }, { status: 404 });

    return NextResponse.json({
      id: category.id,
      label: category.label,
      fullPath: category.full_path,
      audience: category.audience,
      itemFamily: category.item_family,
      isActive: category.is_active,
      isSelectable: category.is_selectable,
      isLeaf: category.is_leaf,
    });
  } catch (error) { return safeApiError(error, "Could not look up this Vinted category."); }
}
